"""Queries over a [lawsmith] log: one JSON event per line, prefixed "[lawsmith] ".

  logq.py count LOG KIND                     number of events of KIND
  logq.py last LOG KIND                      the last event of KIND, as JSON
  logq.py all LOG KIND                       every event of KIND, one JSON per line
  logq.py field LOG KIND DOTTED.PATH         a value from the last event of KIND
  logq.py center LOG OX OY DOTTED.PATH       screen point at the center of a rect [x, y, w, h]
                                             in the last `layout` event, offset by the window origin
  logq.py handle LOG OX OY NAME [INDEX]      screen point of a gizmo handle sample in the last `layout`
  logq.py lawhandle LOG OX OY NAME           screen point of the selected law's spatial handle NAME
                                             (strength, coreRadius, edgeFade, radius, …) in the last `layout`
  logq.py lawhandleworld LOG NAME DX DY DZ   that handle's world point plus a world offset
  logq.py project LOG OX OY X Y Z            screen point of a world point, by the last `layout` camera
  logq.py timeline LOG OX OY TICK            screen point of TICK on the replay timeline in the last `layout`
                                             (its 12 px thumb's center travels the track inside its ends)
"""
import json
import sys


def events(path, kind):
    out = []
    with open(path, encoding='utf-8', errors='replace') as log:
        for line in log:
            if not line.startswith('[lawsmith] {'):
                continue
            try:
                event = json.loads(line[len('[lawsmith] '):])
            except json.JSONDecodeError:
                continue
            if event.get('kind') == kind:
                out.append(event)
    return out


def dig(value, path):
    for key in path.split('.'):
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def main(argv):
    command, log = argv[1], argv[2]
    if command == 'count':
        print(len(events(log, argv[3])))
    elif command == 'last':
        print(json.dumps(events(log, argv[3])[-1]))
    elif command == 'all':
        for event in events(log, argv[3]):
            print(json.dumps(event))
    elif command == 'field':
        print(json.dumps(dig(events(log, argv[3])[-1], argv[4])))
    elif command == 'center':
        x, y, w, h = dig(events(log, 'layout')[-1], argv[5])
        print(round(float(argv[3]) + x + w / 2), round(float(argv[4]) + y + h / 2))
    elif command == 'handle':
        name, index = argv[5], int(argv[6]) if len(argv) > 6 else 0
        handles = [h for h in events(log, 'layout')[-1]['handles'] if h['name'] == name]
        px, py = handles[0]['points'][index] if len(handles[0]['points']) > index else handles[0]['points'][0]
        print(round(float(argv[3]) + px), round(float(argv[4]) + py))
    elif command == 'lawhandle':
        handles = [h for h in events(log, 'layout')[-1]['lawHandles'] if h['name'] == argv[5]]
        if not handles:
            raise SystemExit(f'no law handle {argv[5]} in the last layout')
        px, py = handles[0]['point'][:2]
        print(round(float(argv[3]) + px), round(float(argv[4]) + py))
    elif command == 'lawhandleworld':
        handles = [h for h in events(log, 'layout')[-1]['lawHandles'] if h['name'] == argv[3]]
        if not handles:
            raise SystemExit(f'no law handle {argv[3]} in the last layout')
        print(*(round(c + float(d), 6) for c, d in zip(handles[0]['world'], argv[4:7])))
    elif command == 'project':
        layout = events(log, 'layout')[-1]
        m = layout['viewProjection']  # column-major 4×4
        x, y, z = (float(v) for v in argv[5:8])
        cx = m[0] * x + m[4] * y + m[8] * z + m[12]
        cy = m[1] * x + m[5] * y + m[9] * z + m[13]
        cw = m[3] * x + m[7] * y + m[11] * z + m[15]
        width, height = layout['viewport']
        print(round(float(argv[3]) + (cx / cw + 1) / 2 * width), round(float(argv[4]) + (1 - cy / cw) / 2 * height))
    elif command == 'timeline':
        timeline = events(log, 'layout')[-1]['run']['timeline']
        if not timeline:
            raise SystemExit('no replay timeline in the last layout')
        x, y, w, h = timeline['box']
        fraction = min(1.0, max(0.0, float(argv[5]) / timeline['max'])) if timeline['max'] else 0.0
        print(round(float(argv[3]) + x + 6 + (w - 12) * fraction), round(float(argv[4]) + y + h / 2))
    else:
        raise SystemExit(f'unknown command {command}')


if __name__ == '__main__':
    main(sys.argv)
