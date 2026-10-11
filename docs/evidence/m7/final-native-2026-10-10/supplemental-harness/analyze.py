from pathlib import Path
import copy, hashlib, json, math, sys

ROOT=Path(__file__).resolve().parent.parent
REPO=Path('<checkout>')
sys.path.insert(0,str(REPO/'scripts/verify/native'))
from logq import events
import m7q

SOURCE='0c7c5a7cab60fd6b926c0009deebf832630f9c71'
result={'applicationSourceSha':SOURCE,'nativeHarnessShas':[],'scenarios':[],'manualOwnerInspection':'PENDING','realTrackpad':'PENDING'}

def percentile(values):
    if not values:return None
    ordered=sorted(values)
    return [ordered[min(len(ordered)-1,math.floor(p*len(ordered)))] for p in [.5,.95,.99]]+[ordered[-1]]

for folder in sorted((ROOT/'captures').iterdir()):
    if not folder.is_dir():continue
    outcome=folder/'outcome.json'
    if not outcome.exists():
        result['scenarios'].append({'name':folder.name,'result':'RUNNING_OR_PENDING'});continue
    record=json.loads(outcome.read_text())
    status='PASS' if record['exitCode']==0 and 'cleanupError' not in record else 'FAIL'
    if folder.name=='m7-r1-panel-final': status='EXIT_ZERO / ORDINARY_FIXTURE_INCOMPLETE'
    result['scenarios'].append({'name':folder.name,'result':status,'outcome':record})
    if record['nativeHarnessSha'] not in result['nativeHarnessShas']:result['nativeHarnessShas'].append(record['nativeHarnessSha'])

folder=ROOT/'captures/m7-compare'
if (folder/'outcome.json').exists() and json.loads((folder/'outcome.json').read_text())['exitCode']==0:
    log=folder/'m7-compare.log';layouts=events(log,'layout');comps=events(log,'comparison');fixtures=events(log,'m7-fixtures')
    display=max((e for e in layouts if e.get('comparison') and not e['playing'] and e['comparison']['receipt']['pair'] and e['comparison']['receipt']['pair']['separation'] is not None),key=lambda e:e['comparison']['receipt']['pair']['separation'])
    start=next(e for e in comps if e.get('action')=='alternate-replay')
    end=next(e for e in comps if e.get('action')=='alternate-complete')
    replay_layout=next(e for e in layouts if e['t']>end['t'] and e.get('comparison') and e['comparison']['receipt']['authority']==start['retained']['authority'])
    resources=events(log,'visual-resources')[-20:]
    m7q.separation(display);m7q.replay(start,end,replay_layout);m7q.resources(resources);m7q.fixtures(fixtures)
    result['comparison']={'commonFork':next(e['authority'] for e in layouts if e.get('comparison') and e['comparison']['horizon']==600 and e['authority']['tick']==0),'pausedPair':display['comparison']['receipt']['pair'],'retained':start['retained'],'completed':end,'fixtureCount':sum('case' in e for e in fixtures),'uniqueFixtureCount':len({e['case'] for e in fixtures if 'case' in e}),'fixtures':fixtures,'resourceCycles':resources,'returnedSource':next(e['authority'] for e in layouts if e['t']>end['t'] and e.get('comparison') is None)}
    controls=[]
    for title,fn,args in [('zero numerical separation',m7q.separation,[copy.deepcopy(display)]),('overshot retained endpoint',m7q.replay,[copy.deepcopy(start),copy.deepcopy(end),copy.deepcopy(replay_layout)]),('growing native resources',m7q.resources,[copy.deepcopy(resources)]),('removed stable-ID absence case',m7q.fixtures,[[e for e in fixtures if e.get('case')!='L stable identities and absent counterparts']])]:
        if title=='zero numerical separation':args[0]['comparison']['receipt']['pair'].update(alternate=args[0]['comparison']['receipt']['pair']['baseline'],separation=0)
        elif title=='overshot retained endpoint':args[2]['comparison']['receipt']['authority']['tick']+=1
        elif title=='growing native resources':args[0][-1]['totalBytes']+=1
        try:fn(*args)
        except AssertionError as error:controls.append({'control':title,'rejected':True,'reason':str(error),'mutatedInputs':args})
        else:raise AssertionError('Native negative control accepted: '+title)
    result['nativeNegativeControls']=controls
    observed=[]
    for e in layouts:
        if e.get('visualization'):observed.append(e['visualization'])
    observed+=resources
    result['resourcePeakObservation']={'peakWorldsInternallyTracked':max(e['contexts']['peakWorlds'] for e in observed),'peakRetainedAuthoringWorlds':max(e['contexts']['authoring'] for e in observed),'peakRetainedReplayWorlds':max(e['contexts']['replay'] for e in observed),'peakSeekWorlds':max(e['contexts']['seeking'] for e in observed),'peakCandidateWorlds':max(e['contexts']['candidates'] for e in observed),'peakCheckpointBytes':max(e['contexts']['checkpointBytes'] for e in observed),'peakComparisonBytes':max((e['contexts']['comparison'] or {}).get('bytes',0) for e in observed),'peakGeometries':max(e['render']['geometries'] for e in observed),'peakTextures':max(e['render']['textures'] for e in observed),'peakObjects':max(e['render']['objects'] for e in observed),'limits':'renderer/cache peaks are maxima over captured readbacks; world allocation peak is internally tracked; not exhaustive heap/RSS peaks'}

r1=ROOT/'captures/m7-r1-panel-complete-batched'
if (r1/'outcome.json').exists() and json.loads((r1/'outcome.json').read_text())['exitCode']==0:
    log=r1/'m7-r1-panel.log';ls=events(log,'layout');cs=events(log,'comparison')
    starts=[e for e in cs if e.get('action')=='alternate-replay'];ends=[e for e in cs if e.get('action')=='alternate-complete']
    assert len(starts)==len(ends)==2
    exact=[]
    for start,end in zip(starts,ends):
        shown=next(e for e in ls if e['t']>end['t'] and e.get('comparison') and e['authority']==start['retained']['authority'])
        m7q.replay(start,end,shown);exact.append({'retained':start['retained'],'completed':end,'shown':shown['authority']})
    created=next(e for e in ls if e.get('comparison') and e['comparison']['replaying'] and e['authority']['tick']==121 and e['selected'] is None and any(r['id']=='push' and r['locked'] for r in e['laws']))
    details=[]
    for target,strength,fade in [(121,'0','0'),(201,'3','0'),(281,'3','0.4')]:
        shown=next(e for e in ls if e.get('comparison') and e['comparison']['replaying'] and e['authority']['tick']==target and e['selected']=='sideways' and e['detailTitle']=='Custom current law' and e['inputValues']['Strength']==strength and e['inputValues']['law-fade']==fade)
        assert shown['selectedField']['enabled'] is False and shown['laws'][0]['color']=='#c58ae5' and shown['laws'][0]['visibleState']=='false'
        details.append({'authority':shown['authority'],'detailTitle':shown['detailTitle'],'inputValues':shown['inputValues'],'laws':shown['laws']})
    ordinary=next(e for e in ls if e['run']['contexts']['selected']=='replay' and e['authority']['tick']==121 and e['authority']['cursor']==1)
    assert {r['id'] for r in ordinary['laws']}=={'sideways','push'}
    returned=next(e for e in reversed(ls) if e['run']['contexts']['selected']=='authoring' and e['authority']['tick']==396 and e['authority']['cursor']==1)
    result['completeCorrectedR1']={'actualExit':0,'createdIntermediate':created['authority'],'selectedDetails':details,'exactAlternateEndpoints':exact,'ordinaryIntermediate':ordinary['authority'],'returnedAuthoring':returned['authority']}

performance=[]
for folder in (ROOT/'captures').iterdir():
    if not folder.is_dir():continue
    for log in folder.glob('*.log'):
        if log.name in ['scenario.log','qa-steps.log']:continue
        for kind in ['p3-run','p0-run']:
            for e in events(log,kind):
                recomputed={key:percentile(values) for key,values in e['raw'].items()}
                for raw_key,sample_key in [('stepMs','steps'),('tickMs','steps'),('editMs','edits'),('intervalMs','frames'),('workMs','frames'),('probeMs','probeSteps'),('trailMs','trailSteps')]:
                    assert len(e['raw'][raw_key])==e['samples'][sample_key],(folder.name,raw_key,'sample count mismatch')
                for key,values in recomputed.items():assert values==e[key],(folder.name,key,values,e[key])
                p={'scenario':folder.name,'log':str(log.relative_to(ROOT)),'event':e,'recomputedPercentiles':recomputed,'rawSampleCounts':{key:len(values) for key,values in e['raw'].items()},'ratioFromActualTicksAndWall':(e['ticks']/120)/(e['wallMs']/1000)}
                if kind=='p3-run':
                    p['allP3GatesPass']=bool(e['invalid'] is None and e['incomplete'] is None and e['wallMs']>=60000 and 0<e['ticks']<=7200 and e['samples']['steps']==e['ticks'] and e['samples']['edits']>=50 and e['samples']['frames']>=3000 and e['bodies']==100 and e['workload']['laws']==4 and e['viewport']['css']==[1600,1000] and e['viewport']['pixelRatio']<=1.5 and e['stepMs'][1]<=3 and e['stepMs'][2]<=5 and e['workMs'][1]<=14 and e['intervalMs'][1]<=20 and e['intervalMs'][2]<=34 and e['editMs'][1]<=50 and p['ratioFromActualTicksAndWall']>=.98 and e['comparison']['bytes']<=67108864)
                if kind=='p0-run':
                    is_p0=folder.name=='m4-perf' and e['workload']['laws']==1 and e['samples']['probeSteps']==0
                    step95,step99,work95=(2,4,12) if is_p0 else (3,5,14)
                    p['commonFrameGateAssessment']={'step95Limit':step95,'step99Limit':step99,'cpuWork95Limit':work95,'pass':bool(e['invalid'] is None and e['incomplete'] is None and e['wallMs']>=60000 and all(e['raw'][key] for key in ['stepMs','editMs','intervalMs','workMs']) and e['stepMs'][1]<=step95 and e['stepMs'][2]<=step99 and e['workMs'][1]<=work95 and e['intervalMs'][1]<=20 and e['intervalMs'][2]<=34 and e['editMs'][1]<=50 and p['ratioFromActualTicksAndWall']>=.98)}
                performance.append(p)
result['performance']=performance
resource_observations=[]
fixture_receipts=[]
for folder in (ROOT/'captures').iterdir():
    if not folder.is_dir():continue
    for log in folder.glob('*.log'):
        if log.name in ['scenario.log','qa-steps.log']:continue
        for e in events(log,'visual-resources'):
            resource_observations.append({'scenario':folder.name,'event':e})
        for e in events(log,'layout'):
            if e.get('visualization'):resource_observations.append({'scenario':folder.name,'event':e['visualization']})
        for kind in ['m6a-fixtures','seek-fixtures','m6b-fixtures']:
            for e in events(log,kind):fixture_receipts.append({'scenario':folder.name,'event':e})
if resource_observations:
    keys=['authoring','replay','seeking','candidates','checkpointBytes','peakWorlds']
    result['allCampaignResourceReadbacks']={'observations':resource_observations,'maxContexts':{key:max(v['event']['contexts'].get(key,0) for v in resource_observations) for key in keys},'maxRenderer':{key:max(v['event']['render'].get(key,0) for v in resource_observations) for key in ['geometries','textures','objects']},'limits':'captured readback maxima only except internally tracked peakWorlds; do not infer unobserved continuous heap/RSS peaks'}
result['otherNativeFixtureReceipts']=fixture_receipts
comparison_counts=[]
for folder in (ROOT/'captures').iterdir():
    if not folder.is_dir():continue
    for log in folder.glob('*.log'):
        if log.name in ['scenario.log','qa-steps.log']:continue
        for e in events(log,'comparison'):
            if 'worlds' in e:comparison_counts.append({'scenario':folder.name,'event':e})
if comparison_counts:
    result['comparisonCalculationReadbacks']={'maxComparisonWorlds':max(v['event']['worlds'] for v in comparison_counts),'maxObservedCalculationWorlds':max(max(0,v['event']['worlds']-1) for v in comparison_counts),'maxObservedAccountedBytes':max(v['event'].get('bytes',0) for v in comparison_counts),'countInterpretation':'comparison counts reports one retained B plus one world when its calculation job exists (comparison.ts counts); captured maxima, not continuous process-memory measurement','observations':comparison_counts}
(ROOT/'private/native-analysis.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'scenarios':[(e['name'],e['result']) for e in result['scenarios']],'caseCount':result.get('comparison',{}).get('fixtureCount'),'performanceCaptures':len(performance),'p3Gates':[p['allP3GatesPass'] for p in performance if 'allP3GatesPass' in p]}))
