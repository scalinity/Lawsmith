"""Checks over the [lawsmith] `explanation` events (Shift+E) of an M4 native run.

  m4q.py LOG CHECK [SINCE]    PASS/FAIL and a short reason, for the last `explanation` event (or, for
                              the any-* checks, every one after the first SINCE of them)

Each check reads the retained step the app logged and recomputes what the readout claims, with the
SPEC §17.1 / T03 tolerance 1e-9 + 1e-8·|expected|:
  consistent   the law shares plus gravity's equal the submitted total, and that equals force / mass
  in-drag      a drag law's share is exactly −λβK·v at the sampled velocity (its drive is zero)
  out-of-drag  no drag acts any more, and the body's sideways velocity is below the 3 m/s it was thrown at
  overlap      two or more laws contribute in one step
  contact      a contact is named, and v + h·a alone misses the velocity after the step
  capped-idle  the limiter is idle (λ = 1) while the drawn acceleration arrow is capped (> 2 m at 1 m = 20 m/s²)
  limited      the limiter is active (λ < 1) and the shares are still consistent
  preview-edit the retained step is the same as in the previous event while the preview changed
  same-retained  the retained step is the same as in the previous event
  any-overlap / any-contact   some event after SINCE passes overlap / contact
"""
import json
import sys

H = 1 / 120
ARROW_METERS_PER_MS2 = 0.05
ARROW_CAP_M = 2


def tol(x):
    return 1e-9 + 1e-8 * abs(x)


def events(path):
    out = []
    with open(path, encoding='utf-8', errors='replace') as log:
        for line in log:
            if line.startswith('[lawsmith] {'):
                try:
                    e = json.loads(line[len('[lawsmith] '):])
                except json.JSONDecodeError:
                    continue
                if e.get('kind') == 'explanation':
                    out.append(e)
    return out


def consistent(r):
    for i in range(3):
        total = r['gravityApplied'][i] + sum(c['applied'][i] for c in r['contributions'])
        if abs(total - r['submitted'][i]) > tol(r['submitted'][i]):
            return f'component {i}: shares sum to {total}, submitted {r["submitted"][i]}'
        if abs(r['force'][i] / r['mass'] - r['submitted'][i]) > tol(r['submitted'][i]):
            return f'component {i}: force/mass {r["force"][i] / r["mass"]} vs submitted {r["submitted"][i]}'
    return None


def acting(r):
    return [c for c in r['contributions'] if c['drag'] > 0 or any(c['applied'])]


def check(name, e, previous):
    r = e.get('retained')
    if name in ('preview-edit', 'same-retained'):
        if previous is None:
            return 'no earlier explanation event'
        if r != previous.get('retained'):
            return 'the retained step changed'
        if name == 'preview-edit':
            if e.get('preview') is None or previous.get('preview') is None:
                return 'no preview in one of the events'
            if e['preview']['submitted'] == previous['preview']['submitted']:
                return 'the preview did not change'
        return None
    if r is None:
        return 'no retained step for the explained body'
    problem = consistent(r)
    if problem:
        return problem
    lam, beta, v = r['lambda'], r['beta'], r['velocity']
    if name == 'consistent':
        return None
    if name == 'in-drag':
        drags = [c for c in r['contributions'] if c['drag'] > 0]
        if not drags:
            return 'no drag law reaches the body'
        for c in drags:
            if any(c['drive']):
                continue
            for i in range(3):
                expected = -lam * beta * c['drag'] * v[i]
                if abs(c['applied'][i] - expected) > tol(expected):
                    return f'{c["id"]} share {c["applied"][i]} vs −λβK·v {expected}'
        return None
    if name == 'out-of-drag':
        if any(c['drag'] > 0 for c in r['contributions']):
            return 'a drag law still acts'
        return None if r['after']['velocity'][0] < 2.7 else f'sideways velocity {r["after"]["velocity"][0]} not reduced'
    if name == 'overlap':
        return None if len(acting(r)) >= 2 else f'{len(acting(r))} law(s) act'
    if name == 'contact':
        if not r.get('contacts'):
            return 'no contact named'
        miss = max(abs(r['after']['velocity'][i] - (v[i] + H * r['submitted'][i])) for i in range(3))
        return None if miss > 2e-5 else f'v + h·a predicts the outcome to {miss}'
    if name == 'capped-idle':
        drawn = sum(a * a for a in r['submitted']) ** 0.5 * ARROW_METERS_PER_MS2
        return None if lam == 1 and drawn > ARROW_CAP_M else f'λ {lam}, drawn {drawn} m'
    if name == 'limited':
        return None if lam < 1 else f'λ {lam}'
    return f'unknown check {name}'


def main(argv):
    log, name = argv[1], argv[2]
    all_events = events(log)
    if not all_events:
        print('FAIL no explanation events')
        return
    if name.startswith('any-'):
        since = int(argv[3]) if len(argv) > 3 else 0
        tail = all_events[since:]
        hits = [e for e in tail if check(name[4:], e, None) is None]
        print(f'PASS {len(hits)} of {len(tail)} events' if hits else f'FAIL none of {len(tail)} events')
        return
    e = all_events[-1]
    problem = check(name, e, all_events[-2] if len(all_events) > 1 else None)
    r = e.get('retained') or {}
    summary = f"tick {r.get('fromTick')}→{r.get('toTick')} λ {r.get('lambda')} β {r.get('beta')} contacts {r.get('contacts')}"
    print(f'PASS {summary}' if problem is None else f'FAIL {problem} ({summary})')


if __name__ == '__main__':
    main(sys.argv)
