"""M8 assertions over the packaged app's own `layout` readbacks (Shift+L). Each raises AssertionError
with the offending ids and boxes; the scenarios stop on the first failure.

  m8q.py surface LOG               last layout: one continuous surface, nothing overlapping, nothing
                                   off the window, scrolling only where a panel scrolls
  m8q.py lights LOG LIGHTS_JSON    last layout: no control within 6 px of a native traffic light
  m8q.py scale LOG BASE_INDEX      last layout against layout BASE_INDEX: Interface Scale changed
                                   neither the simulation nor the renderer's pixel ratio or canvas
  m8q.py example LOG KEY LAW       last layout: example KEY open, LAW selected, its invitation shown
  m8q.py labels LOG                last layout: every visible law named in the viewport, selection and
                                   disabled state marked without color
  m8q.py focus LOG [ID]            last layout: a focused control (ID if given) with a visible ring,
                                   wholly inside the window
Boxes are [x, y, width, height] in CSS pixels of the content view.
"""
import json
import sys

# Always in view: the top rail, the scene card and the dock never scroll.
FIXED = ['play', 'step', 'reset', 'undo', 'redo', 'file-new', 'file-open', 'file-save', 'file-save-as',
         'example-open', 'panel-toggle', 'frame-view', 'reset-view', 'mode-translate', 'mode-rotate', 'mode-scale']
# Regions that must never cover one another.
REGIONS = ['document', 'panel', 'context-column', 'dock', 'tools', 'diagnostics']
# Cards stacked inside the context column: none may cover another (M7's fault banner did).
CARDS = ['sim-error', 'run', 'comparison', 'explain']
SCROLLERS = {'panel': 'panel', 'context-column': 'context-column'}
EPS = 0.5


def events(path, kind):
    out = []
    with open(path, encoding='utf-8', errors='replace') as log:
        for line in log:
            if line.startswith('[lawsmith] {'):
                try:
                    event = json.loads(line[len('[lawsmith] '):])
                except json.JSONDecodeError:
                    continue
                if event.get('kind') == kind:
                    out.append(event)
    return out


def overlaps(a, b):
    return a[0] < b[0] + b[2] - EPS and b[0] < a[0] + a[2] - EPS and a[1] < b[1] + b[3] - EPS and b[1] < a[1] + a[3] - EPS


def inside(box, w, h):
    return box[0] >= -EPS and box[1] >= -EPS and box[0] + box[2] <= w + EPS and box[1] + box[3] <= h + EPS


def within(box, outer):
    return box[0] >= outer[0] - EPS and box[1] >= outer[1] - EPS and box[0] + box[2] <= outer[0] + outer[2] + EPS and box[1] + box[3] <= outer[1] + outer[3] + EPS


def surface(layout):
    w, h = layout['viewport']
    c = layout['controls']
    problems = []
    for key in FIXED:
        box = c.get(key)
        if box is None:
            problems.append(f'{key} is not shown')
        elif not inside(box, w, h):
            problems.append(f'{key} {box} leaves the {w}x{h} window')
    present = [r for r in REGIONS if c.get(r)]
    for i, a in enumerate(present):
        for b in present[i + 1:]:
            if overlaps(c[a], c[b]):
                problems.append(f'{a} {c[a]} overlaps {b} {c[b]}')
    cards = [k for k in CARDS if c.get(k)]
    for i, a in enumerate(cards):
        for b in cards[i + 1:]:
            if overlaps(c[a], c[b]):
                problems.append(f'{a} {c[a]} overlaps {b} {c[b]}')
    # The drag band never lies under a control: it is a separate, empty hit target.
    band = c.get('drag-region')
    if band is None:
        problems.append('no drag region')
    for key, box in c.items():
        if box is None or key in REGIONS or key in CARDS or key in ('drag-region', 'scene-column', 'context-column', 'dock', 'top-rail'):
            continue
        if band and overlaps(band, box):
            problems.append(f'drag region {band} lies under {key} {box}')
        # Nothing scrolls sideways; a control below a scrolling panel's edge is reachable by scrolling.
        if box[0] < -EPS or box[0] + box[2] > w + EPS:
            problems.append(f'{key} {box} is cut off horizontally')
    for name, scroll in layout.get('scroll', {}).items():
        if scroll['scrollWidth'] > scroll['clientWidth'] + 1:
            problems.append(f'{name} scrolls sideways ({scroll["scrollWidth"]} > {scroll["clientWidth"]})')
    for key, box in c.items():
        if box is None or key in FIXED or inside(box, w, h):
            continue
        holders = [s for s in SCROLLERS if c.get(s) and box[0] >= c[s][0] - EPS and box[0] + box[2] <= c[s][0] + c[s][2] + EPS]
        if not holders:
            problems.append(f'{key} {box} is outside the window and in no scrolling panel')
    assert not problems, '; '.join(problems)
    return {'viewport': [w, h], 'scale': layout.get('interfaceScale'), 'checked': len(c)}


def lights(layout, frames):
    """frames: [{name, x, y, w, h}] of the native close/minimize/zoom buttons, in content-view points."""
    problems = []
    for light in frames:
        clear = [light['x'] - 6, light['y'] - 6, light['w'] + 12, light['h'] + 12]
        for key, box in layout['controls'].items():
            if box is None or key in ('drag-region', 'top-rail', 'scene-column', 'context-column', 'dock'):
                continue
            if overlaps(clear, box):
                problems.append(f'{key} {box} within 6 px of {light["name"]} {light}')
    assert not problems, '; '.join(problems)
    return {'lights': len(frames)}


def scale(base, now):
    problems = []
    if now['authority'] != base['authority']:
        problems.append(f'authority changed: {base["authority"]} -> {now["authority"]}')
    if now['pixelRatio'] != base['pixelRatio']:
        problems.append(f'pixel ratio changed: {base["pixelRatio"]} -> {now["pixelRatio"]}')
    if now['viewport'] != base['viewport']:
        problems.append(f'viewport changed: {base["viewport"]} -> {now["viewport"]}')
    if now['canvas'] != base['canvas']:
        problems.append(f'canvas backing size changed: {base["canvas"]} -> {now["canvas"]}')
    assert not problems, '; '.join(problems)
    return {'from': base.get('interfaceScale'), 'to': now.get('interfaceScale'), 'pixelRatio': now['pixelRatio']}


def example(layout, key, law):
    problems = []
    if layout.get('example') != key:
        problems.append(f'example is {layout.get("example")}, not {key}')
    if layout.get('selected') != law:
        problems.append(f'selected law is {layout.get("selected")}, not {law}')
    if layout['controls'].get('doc-invitation') is None:
        problems.append('no invitation shown')
    if layout.get('playing') or layout['authority']['tick'] != 0:
        problems.append(f'not paused at tick 0: playing {layout.get("playing")}, tick {layout["authority"]["tick"]}')
    assert not problems, '; '.join(problems)
    return {'example': key, 'law': law}


def labels(layout):
    problems = []
    shown = layout.get('lawLabels', {})
    for field in layout['appliedLaws']:
        row = next((r for r in layout['laws'] if r['id'] == field['id']), None)
        if row is None:
            problems.append(f'{field["id"]} missing from the Laws list')
            continue
        if row['visibleState'] != 'true':
            continue
        label = shown.get(field['id'])
        if label is None:
            problems.append(f'{field["id"]} has no viewport label')
            continue
        if label['selected'] != (field['id'] == layout['selected']):
            problems.append(f'{field["id"]} selection mark is {label["selected"]}')
        if field['enabled'] == label['text'].endswith(' off'):
            problems.append(f'{field["id"]} enabled {field["enabled"]} but label reads {label["text"]!r}')
        if row['enabledText'] != ('On' if field['enabled'] else 'Off'):
            problems.append(f'{field["id"]} row reads {row["enabledText"]}')
    assert not problems, '; '.join(problems)
    return {'labels': len(shown)}


def focus(layout, want=None):
    f = layout.get('focus')
    w, h = layout['viewport']
    assert f is not None, 'nothing has keyboard focus'
    assert want is None or f['id'] == want, f'focus is on {f["id"]}, not {want}'
    assert f['focusVisible'] and f['outline'][0] != 'none', f'{f["id"]} has no visible focus ring: {f}'
    assert f['box'] is not None and inside(f['box'], w, h), f'focused {f["id"]} {f["box"]} is not wholly in the window'
    return {'focus': f['id']}


def main(argv):
    command, log = argv[1], argv[2]
    layouts = events(log, 'layout')
    last = layouts[-1]
    if command == 'surface':
        result = surface(last)
    elif command == 'lights':
        result = lights(last, json.loads(argv[3]))
    elif command == 'scale':
        result = scale(layouts[int(argv[3])], last)
    elif command == 'example':
        result = example(last, argv[3], argv[4])
    elif command == 'labels':
        result = labels(last)
    elif command == 'focus':
        result = focus(last, argv[3] if len(argv) > 3 else None)
    else:
        raise SystemExit(f'unknown command {command}')
    print(json.dumps({'check': command, 'pass': True, **result}))


if __name__ == '__main__':
    main(sys.argv)
