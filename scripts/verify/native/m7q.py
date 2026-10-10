"""Assert M7 native results from structured app readbacks. No GUI operations."""
import math
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from logq import events


def require(pass_, message):
    if not pass_:
        raise AssertionError(message)


def separation(layout):
    c = layout['comparison']
    pair = c['receipt']['pair']
    require(pair is not None and pair['tick'] == c['tick'], 'equal-tick body pair missing')
    require(pair['baseline'] is not None and pair['alternate'] is not None, 'counterpart absent')
    actual = math.dist(pair['baseline'], pair['alternate'])
    require(math.isfinite(actual) and actual >= 0.5 and abs(actual - pair['separation']) < 1e-9, 'actual separation below 0.5 m or incorrect readout')
    require(not c['receipt']['framePastHorizon'], 'fabricated frame beyond horizon')


def replay(start, end, layout):
    expected = start['retained']
    actual = end['receipt']
    require(end['t'] >= start['t'], 'stale replay completion')
    require(actual['authority'] == expected['authority'], 'retained endpoint/state/engine mismatch')
    require(actual['baselineHash'] == expected['baselineHash'], 'baseline mutated during replay')
    require(end['suffix'] == start['suffix'], 'consumed suffix changed')
    require(end['playing'] is False and layout['playing'] is False, 'replay did not pause')
    require(layout['comparison']['replaying'] is False, 'replay still active')
    require(layout['comparison']['receipt']['authority'] == expected['authority'], 'frame overshot after replay')
    require(not actual['framePastHorizon'], 'fabricated baseline frame')


def ghosts(before, toggles):
    require(len(toggles) == 2 and [e['shown'] for e in toggles] == [False, True], 'two ghost toggles missing')
    for event in toggles:
        require(event['receipt']['authority'] == before['authority'], 'ghost toggle changed B authority')
        require(event['receipt']['baselineHash'] == before['baselineHash'], 'ghost toggle changed A')


def resources(samples):
    require(len(samples) == 20, 'twenty native resource cycles required')
    # World, geometry, texture, scene-object and managed-buffer counts must return after every close.
    def counts(s):
        return {**{key: s[key] for key in ('render', 'bytes', 'totalBytes')}, 'contexts': {k: v for k, v in s['contexts'].items() if k != 'peakWorlds'}}
    first = counts(samples[0])
    for sample in samples:
        require(counts(sample) == first, 'resource counts grew or failed to return to steady state')
        require(sample['contexts']['comparison'] is None, 'comparison resources retained after close')
        require(sample['contexts']['worlds'] == sample['contexts']['authoring'] + sample['contexts']['replay'], 'abandoned world retained')


def fixtures(samples):
    require(any(e.get('complete') is True for e in samples), 'packaged fixtures incomplete')
    require(all(e.get('pass') is True for e in samples if 'case' in e), 'packaged fixture failure')
    require(any(e.get('case') == 'L stable identities and absent counterparts' and e.get('pass') is True and e.get('tick') == 8 and e.get('unequalTickRejected') is True and e.get('indexSeparation', 0) > 0 for e in samples), 'missing stable-ID/absence negative control')
    for case in ('F effective absolute triangle', 'I retained suffix replay', 'P late commit refusal', 'resources released', 'F1 frame budget 2', 'F1 frame budget 8', 'F1 paused boundary 0', 'F1 paused boundary 73', 'F2 immediate refusal replay 0/false', 'F2 immediate refusal replay 0/true', 'F2 immediate refusal replay 7/false', 'F2 immediate refusal replay 7/true', 'F3 completed-step probes and late negative control', 'F4 importable title 8180', 'F4 importable title 8181', 'F4 importable title 8192', 'F5 comparison fault recovery', 'source law presentation', 'D/E nonvacuous source-tail control'):
        require(any(e.get('case') == case and e.get('pass') is True for e in samples), f'missing {case}')
    retained = next(e for e in samples if e.get('case') == 'I retained suffix replay')
    require(retained['expected'] == retained['actual'] and retained['completeStateEqual'] and retained['engineEqual'], 'complete replay state/engine inequality')
    canceled = next(e for e in samples if e.get('case') == 'P late commit refusal')
    require(canceled['canceledResult'] == 'canceled' and canceled['horizon'] == 600 and not canceled['framePastHorizon'], 'stale canceled baseline result')


def main(argv):
    mode, log = argv[1:3]
    layouts = events(log, 'layout')
    comparisons = events(log, 'comparison')
    require(all(e['mode'] == 'packaged' for e in layouts + comparisons), 'native assertions require packaged runtime events')
    if mode == 'separation':
        separation(layouts[-1])
    elif mode == 'replay':
        start = next(e for e in reversed(comparisons) if e.get('action') == 'alternate-replay')
        end = next(e for e in reversed(comparisons) if e.get('action') == 'alternate-complete')
        replay(start, end, layouts[-1])
    elif mode == 'ghosts':
        toggles = [e for e in comparisons if e.get('action') == 'ghosts'][-2:]
        baseline = next(e for e in reversed(layouts) if e.get('comparison') and e['t'] < toggles[0]['t'])
        ghosts(baseline['comparison']['receipt'], toggles)
    elif mode == 'resources':
        samples = events(log, 'visual-resources')[-20:]
        require(samples and all(e['mode'] == 'packaged' for e in samples), 'packaged resource samples required')
        resources(samples)
    elif mode == 'fixtures':
        samples = events(log, 'm7-fixtures')
        require(samples and all(e['mode'] == 'packaged' for e in samples), 'packaged fixture events required')
        fixtures(samples)
    else:
        raise ValueError(f'unknown mode {mode}')
    print(f'M7 {mode}: PASS (structured native log)')


if __name__ == '__main__':
    main(sys.argv)
