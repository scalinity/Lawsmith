"""M6B checks over one session's [lawsmith] log, read in order, with this script's own code.

  m6bq.py checkpoints LOG RUN_ID   every replay run-checkpoint equals the live one at its address, labeled by
                                   the world that produced it: built from the root by Replay or Replay from
                                   start, or the world a seek restored from a checkpoint or rebuilt
  m6bq.py seeks LOG [SINCE_ID]     every committed seek has a request and holds exactly its target; no request
                                   that was superseded or canceled ever commits; counts and timings
  m6bq.py retained LOG             every digest of the retained authoring world logged at a context switch since
                                   the first replay (each seek's commit included) is the same: seeking, canceling
                                   and returning never touched it
  m6bq.py latest LOG SINCE_ID      over the requests after SINCE_ID: each commit is the newest request at that
                                   moment, some were superseded, and the last request is committed and shown
"""
import json
import sys


def ordered(path):
    out = []
    with open(path, encoding='utf-8', errors='replace') as log:
        for line in log:
            if not line.startswith('[lawsmith] {'):
                continue
            try:
                out.append(json.loads(line[len('[lawsmith] '):]))
            except json.JSONDecodeError:
                continue
    return out


def checkpoints(path, run_id):
    events = ordered(path)
    live = {(e['tick'], e['cursor']): e for e in events if e.get('kind') == 'run-checkpoint' and e['source'] == 'live' and e['runId'] == run_id}
    if not live:
        return 'FAIL', 'no live checkpoints for this run'
    origin = None
    compared, differ, unmatched = {}, [], []
    for e in events:
        kind = e.get('kind')
        if kind == 'context' and e.get('reason') in ('replay', 'replay-restart', 'open-recording'):
            origin = 'root'
        elif kind == 'seek' and e.get('action') == 'committed':
            origin = 'seek-' + e['source']['kind']
        elif kind == 'run-checkpoint' and e['source'] == 'replay' and e['runId'] == run_id:
            address = (e['tick'], e['cursor'])
            if address not in live:
                unmatched.append(address)
                continue
            same = (e['stateSha256'], e['engineSha256']) == (live[address]['stateSha256'], live[address]['engineSha256'])
            compared[origin] = compared.get(origin, 0) + 1
            if not same:
                differ.append((origin, address))
    if differ or unmatched:
        return 'FAIL', f'differing {differ[:5]}, without a live checkpoint {unmatched[:5]}'
    if not compared.get('seek-checkpoint'):
        return 'FAIL', f'no replay checkpoint came from a restored world: {compared}'
    return 'PASS', f'every replay checkpoint equals the live one at its address, by origin {compared}'


def seeks(path, since=0):
    events = [e for e in ordered(path) if e.get('kind') == 'seek' and e.get('id', since + 1) > since]
    requested = {e['id']: e for e in events if e['action'] == 'request'}
    committed = {e['id']: e for e in events if e['action'] == 'committed'}
    ended = {e['id']: e['action'] for e in events if e['action'] in ('superseded', 'canceled', 'failed')}
    problems = []
    for i, e in committed.items():
        if i not in requested:
            problems.append(f'{i} committed without a request')
        if e['address'] != e['target']:
            problems.append(f"{i} committed at {e['address']}, not its target {e['target']}")
        if i in ended:
            problems.append(f'{i} committed after it was {ended[i]}')
    failed = [i for i, a in ended.items() if a == 'failed']
    if failed:
        problems.append(f'failed {failed}')
    sources = {}
    for e in committed.values():
        sources[e['source']['kind']] = sources.get(e['source']['kind'], 0) + 1
    summary = f"{len(requested)} requested, {len(committed)} committed {sources}, {sum(a == 'superseded' for a in ended.values())} superseded, {sum(a == 'canceled' for a in ended.values())} canceled"
    return ('FAIL', '; '.join(problems)) if problems else ('PASS', summary)


def latest(path, since):
    """Over the seeks after ID `since` (a burst): each commit is the newest request at that moment; the last request commits and is shown."""
    events = ordered(path)
    newest = None
    stale, commits, requests, superseded = [], [], [], 0
    for e in events:
        if e.get('kind') != 'seek' or e.get('id', 0) <= since:
            continue
        if e['action'] == 'request':
            newest = e
            requests.append(e)
        elif e['action'] == 'superseded':
            superseded += 1
        elif e['action'] == 'committed':
            commits.append(e['id'])
            if newest is None or e['id'] != newest['id']:
                stale.append(e['id'])
    if len(requests) < 2:
        return 'FAIL', f'{len(requests)} requests after {since}: not a burst'
    last = requests[-1]
    shown = [e for e in events if e.get('kind') == 'layout'][-1]['run']['replay']['address']
    ok = not stale and commits and commits[-1] == last['id'] and shown == last['target'] and superseded > 0
    return ('PASS' if ok else 'FAIL'), f"{len(requests)} requests, {superseded} superseded, {len(commits)} committed (stale {stale}); the last {last['id']} at {last['target']}, shown {shown}"


def retained(path):
    events = ordered(path)
    first = next((i for i, e in enumerate(events) if e.get('kind') == 'context' and e.get('reason') == 'replay'), None)
    if first is None:
        return 'FAIL', 'no replay in this log'
    keys = ('tick', 'cursor', 'stateSha256', 'engineSha256', 'revision', 'generation', 'canUndo', 'canRedo')
    lives = [e for e in events[first:] if e.get('kind') == 'context-live']
    reasons = {}
    for e in lives:
        reasons[e['reason']] = reasons.get(e['reason'], 0) + 1
    differ = [e['reason'] for e in lives if any(e[k] != lives[0][k] for k in keys)]
    if len(lives) < 2 or differ:
        return 'FAIL', f'{len(lives)} digests, differing at {differ[:5]}'
    return 'PASS', f"{len(lives)} digests identical, state {lives[0]['stateSha256'][:12]} engine {lives[0]['engineSha256'][:12]}, by switch {reasons}"


def main(argv):
    command, *args = argv[1:]
    if command == 'checkpoints':
        verdict, detail = checkpoints(args[0], args[1])
    elif command == 'seeks':
        verdict, detail = seeks(args[0], int(args[1]) if len(args) > 1 else 0)
    elif command == 'retained':
        verdict, detail = retained(args[0])
    elif command == 'latest':
        verdict, detail = latest(args[0], int(args[1]))
    else:
        raise SystemExit(f'unknown command {command}')
    print(verdict, detail)


if __name__ == '__main__':
    main(sys.argv)
