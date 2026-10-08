"""Checks over the [lawsmith] events of an M5 native run, against an independent evaluator.

  m5q.py LOG ingredients LABEL,LABEL,…   the last `explanation` event's retained step splits the
                                         selected compound law into these ingredients, and every part is
                                         recomputed here from the retained law, center, velocity, tick,
                                         beta and lambda (SPEC §6.3, §7, §9.1); the parts add up to the law's
                                         share, and the shares plus gravity to the submitted total
  m5q.py LOG preview LABEL,LABEL,…       the same for the last event's next-step preview
  m5q.py LOG triangle LABEL G            the ingredient LABEL carries a triangle gain whose value at the
                                         retained step's tick is G (a number, or `any`), recomputed here
  m5q.py LOG same-retained               the last two `explanation` events hold the same retained step and
                                         the same preview: a paused tick holds its values
  m5q.py LOG held MIN MAX                bodies in the last `layout` whose centers are inside the selected
                                         law's support number between MIN and MAX
  m5q.py LOG count-held                  that number, printed

This evaluator is written from the SPEC, not from the app: Python floats are IEEE doubles, so a
faithful reimplementation reproduces the app's sums to within the T03 tolerance 1e-9 + 1e-8·|x|.
"""
import json
import math
import sys


def tol(x):
    return 1e-9 + 1e-8 * abs(x)


def events(path, kind):
    out = []
    with open(path, encoding='utf-8', errors='replace') as log:
        for line in log:
            if line.startswith('[lawsmith] {'):
                try:
                    e = json.loads(line[len('[lawsmith] '):])
                except json.JSONDecodeError:
                    continue
                if e.get('kind') == kind:
                    out.append(e)
    return out


# ---------------------------------------------------------------- SPEC §6.3, §7 from scratch

def rot(q):
    x, y, z, w = q
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]


def to_local(pose, p):
    m = rot(pose['rotation'])
    d = [p[i] - pose['position'][i] for i in range(3)]
    return [sum(m[r][c] * d[r] for r in range(3)) for c in range(3)]  # Rᵀ d


def gauge(region, r):
    k = region['kind']
    if k == 'box':
        return max(abs(r[i]) / region['halfExtents'][i] for i in range(3))
    if k == 'sphere':
        return math.sqrt(r[0] ** 2 + r[1] ** 2 + r[2] ** 2) / region['radius']
    return max(math.sqrt(r[0] ** 2 + r[2] ** 2) / region['radius'], abs(r[1]) / region['halfHeight'])


def weight(d, f):
    if f == 0:
        return 1.0 if d <= 1 else 0.0
    z = min(1.0, max(0.0, (1 - d) / f))
    return z * z * (3 - 2 * z)


def gain_at(g, n):
    if g['kind'] == 'constant':
        return g['value']
    p, phase = g['periodTicks'], g['phaseTicks']
    q = ((n + phase) % p) / p  # Python integers are exact, so (n + phase) never rounds here
    return g['min'] + (g['max'] - g['min']) * (1 - abs(2 * q - 1))


def evaluate(e, r, n):
    """(A, K) of an expression at law-local r and tick n, before the law's outer support."""
    k = e['kind']
    if k == 'directional':
        return [e['strength'] * c for c in e['direction']], 0.0
    if k == 'softRadial':
        c = -e['strength'] / math.sqrt(r[0] ** 2 + r[1] ** 2 + r[2] ** 2 + e['coreRadius'] ** 2)
        return [c * r[0], c * r[1], c * r[2]], 0.0
    if k == 'vortexY':
        c = e['strength'] / math.sqrt(r[0] ** 2 + r[2] ** 2 + e['coreRadius'] ** 2)
        return [c * r[2], 0.0, -c * r[0]], 0.0
    if k == 'linearDrag':
        return [0.0, 0.0, 0.0], e['coefficient']
    if k == 'sum':
        a, kk = [0.0, 0.0, 0.0], 0.0
        for t in e['terms']:
            ta, tk = evaluate(t, r, n)
            a = [a[i] + ta[i] for i in range(3)]
            kk += tk
        return a, kk
    if k == 'gain':
        g = gain_at(e['gain'], n)
        ca, ck = evaluate(e['child'], r, n)
        return [g * c for c in ca], g * ck
    if k == 'mask':
        w = weight(gauge(e['region'], to_local(e['pose'], r)), e['edgeFade'])
        ca, ck = evaluate(e['child'], r, n)  # the child stays in the law frame
        return [w * c for c in ca], w * ck
    raise ValueError(f'unknown kind {k}')


def ingredients_of(e):
    """(path, node) of each top-level ingredient: a sum's terms, or the whole expression."""
    return [((i,), t) for i, t in enumerate(e['terms'])] if e['kind'] == 'sum' else [((), e)]


def core_label(node):
    while node['kind'] in ('gain', 'mask'):
        node = node['child']
    return {'directional': 'Push', 'softRadial': 'Pull', 'vortexY': 'Swirl', 'linearDrag': 'Drag', 'sum': 'Group'}[node['kind']]


def labels(nodes):
    seen, out = {}, []
    for node in nodes:
        base = core_label(node)
        seen[base] = seen.get(base, 0) + 1
        out.append(base if seen[base] == 1 else f'{base} {seen[base]}')
    return out


def recompute(o, law):
    """Each ingredient's (drive, drag, applied) recomputed from the observation's own record."""
    m = rot(law['pose']['rotation'])
    r = to_local(law['pose'], o['center'])
    w0 = weight(gauge(law['region'], r), law['edgeFade']) if law['enabled'] else 0.0
    f = o['lambda'] * o['beta']
    v = o['velocity']
    out = []
    for path, node in ingredients_of(law['expression']):
        a, k = evaluate(node, r, o['fromTick'])
        drive = [w0 * sum(m[i][j] * a[j] for j in range(3)) for i in range(3)]
        drag = w0 * k
        out.append((drive, drag, [f * (drive[i] - drag * v[i]) for i in range(3)]))
    return out


def check_split(o, splits, want):
    if o is None:
        return 'no step in the event'
    # The shares plus gravity equal the submitted total, which equals force / mass (M4's consistency).
    for i in range(3):
        total = o['gravityApplied'][i] + sum(c['applied'][i] for c in o['contributions'])
        if abs(total - o['submitted'][i]) > tol(o['submitted'][i]):
            return f'component {i}: shares sum to {total}, submitted {o["submitted"][i]}'
    compound = [(i, law) for i, law in enumerate(o['laws']) if law['expression']['kind'] not in ('directional', 'softRadial', 'vortexY', 'linearDrag')]
    if not compound:
        return 'no compound law in the step'
    for index, law in compound:
        split = next((s for s in splits if s['id'] == law['id']), None)
        if split is None:
            return f'no ingredient split for {law["id"]}'
        names = [s['label'] for s in split['ingredients']]
        if names != labels([n for _, n in ingredients_of(law['expression'])]):
            return f'{law["id"]}: labels {names} are not the expression’s'
        if want and names != want:
            return f'{law["id"]}: ingredients {names}, expected {want}'
        if not split['reconciled']:
            return f'{law["id"]}: the app reports its parts unreconciled'
        expected = recompute(o, law)
        for s, (drive, drag, applied) in zip(split['ingredients'], expected):
            for i in range(3):
                if abs(s['drive'][i] - drive[i]) > tol(drive[i]) or abs(s['applied'][i] - applied[i]) > tol(applied[i]):
                    return f'{law["id"]} {s["label"]} component {i}: app {s["applied"][i]}, recomputed {applied[i]}'
            if abs(s['drag'] - drag) > tol(drag):
                return f'{law["id"]} {s["label"]}: drag {s["drag"]}, recomputed {drag}'
        law_share = o['contributions'][index]['applied']
        for i in range(3):
            total = sum(a[i] for _, _, a in expected)
            if abs(total - law_share[i]) > tol(law_share[i]):
                return f'{law["id"]} component {i}: ingredients sum to {total}, the law’s share is {law_share[i]}'
    return None


def held(layout):
    law = layout.get('selectedField')
    if not law:
        return None
    return sum(1 for b in layout['bodies'] if gauge(law['region'], to_local(law['pose'], b['world'])) < 1)


def main(argv):
    log, name, args = argv[1], argv[2], argv[3:]
    if name in ('held', 'count-held'):
        count = held(events(log, 'layout')[-1])
        if name == 'count-held':
            print(count)
            return
        lo, hi = int(args[0]), int(args[1])
        print(('PASS' if count is not None and lo <= count <= hi else 'FAIL') + f' {count} bodies inside the selected law (want {lo}–{hi})')
        return
    found = events(log, 'explanation')
    if not found:
        print('FAIL no explanation event')
        return
    e = found[-1]
    problem = None
    if name in ('ingredients', 'preview'):
        o = e['retained'] if name == 'ingredients' else e['preview']
        splits = e['retainedIngredients'] if name == 'ingredients' else e['previewIngredients']
        want = args[0].split(',') if args and args[0] else None
        problem = check_split(o, splits or [], want)
        summary = '' if problem else f'tick {o["fromTick"]}: ' + '; '.join(f'{s["label"]} {math.hypot(*s["applied"]):.3f} m/s²' for sp in splits for s in sp['ingredients'])
    elif name == 'triangle':
        o = e['retained']
        label, value = args[0], args[1]
        law = next(l for l in o['laws'] if l['expression']['kind'] == 'sum')
        nodes = [n for _, n in ingredients_of(law['expression'])]
        node = nodes[labels(nodes).index(label)]
        if node['kind'] != 'gain' or node['gain']['kind'] != 'triangle':
            problem = f'{label} has no triangle gain'
        else:
            g = gain_at(node['gain'], o['fromTick'])
            split = next(s for s in e['retainedIngredients'] if s['id'] == law['id'])
            share = split['ingredients'][labels(nodes).index(label)]
            factor = share['factors'][0]['value']
            if abs(factor - g) > tol(g):
                problem = f'the app says gain {factor} at tick {o["fromTick"]}; the formula gives {g}'
            elif value != 'any' and abs(g - float(value)) > tol(float(value)):
                problem = f'gain {g} at tick {o["fromTick"]}, expected {value}'
            summary = f'{label} gain {g} at tick {o["fromTick"]}'
    elif name == 'same-retained':
        if len(found) < 2:
            problem = 'fewer than two explanation events'
        else:
            a, b = found[-2], found[-1]
            if json.dumps(a['retained'], sort_keys=True) != json.dumps(b['retained'], sort_keys=True):
                problem = 'the retained step changed'
            elif json.dumps(a['preview'], sort_keys=True) != json.dumps(b['preview'], sort_keys=True):
                problem = 'the preview changed while paused'
            elif a['tick'] != b['tick']:
                problem = f'the tick moved from {a["tick"]} to {b["tick"]}'
            summary = f'held at tick {b["tick"]}'
    else:
        raise SystemExit(f'unknown check {name}')
    print(f'FAIL {problem}' if problem else f'PASS {summary}')


if __name__ == '__main__':
    main(sys.argv)
