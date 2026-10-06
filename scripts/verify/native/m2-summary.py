"""Summarizes M2 performance evidence from [lawsmith] logs (SPEC §18; MILESTONES M2 performance gate).

  python3 -I m2-summary.py LOG…

Open: native bounded read + validation + candidate world + commit (`openMs`), never dialog time.
Save: capture (settle, snapshot, serialize) + native replacement round trip (`saveMs`).
Recovery: main-thread capture time of each snapshot (`captureMs`) and its acknowledgment (`ackMs`).
Stalls: frame intervals over 50 ms, and whether a recovery write landed within 100 ms of one.
"""
import json
import sys


def events(path):
    with open(path, encoding='utf-8', errors='replace') as log:
        for line in log:
            if line.startswith('[lawsmith] {'):
                try:
                    yield json.loads(line[len('[lawsmith] '):])
                except json.JSONDecodeError:
                    pass


def stats(values):
    if not values:
        return 'none'
    ordered = sorted(values)
    return f"n={len(ordered)} min={ordered[0]} p50={ordered[len(ordered) // 2]} max={ordered[-1]}"


opens, saves, captures, acks, stalls, recovery_near_stall = [], [], [], [], [], 0
for path in sys.argv[1:]:
    log = list(events(path))
    writes = [e['t'] for e in log if e.get('kind') == 'recovery' and e.get('action') == 'write' and 'captureMs' in e]
    for e in log:
        kind = e.get('kind')
        if kind == 'document' and e.get('outcome') == 'committed' and 'openMs' in e:
            opens.append(e['openMs'])
        elif kind == 'document' and e.get('outcome') == 'saved':
            saves.append(e['saveMs'])
        elif kind == 'recovery' and e.get('action') == 'write' and 'captureMs' in e:
            captures.append(e['captureMs'])
            acks.append(e['ackMs'])
        elif kind == 'stall' and e.get('playing'):
            stalls.append(e['intervalMs'])
            if any(abs(e['t'] - t) <= 100 for t in writes):
                recovery_near_stall += 1

print(f"open ms (gate ≤ 500): {stats(opens)}")
print(f"save ms (gate ≤ 500): {stats(saves)}")
print(f"recovery capture ms, main thread (gate ≤ 50): {stats(captures)}")
print(f"recovery acknowledgment ms: {stats(acks)}")
print(f"stalls > 50 ms while playing: {stats(stalls)}; within 100 ms of a recovery write: {recovery_near_stall}")
