from pathlib import Path
import datetime, hashlib, json, os, plistlib, runpy, signal, subprocess, time

ROOT=Path(__file__).resolve().parent.parent
helpers=runpy.run_path(str(ROOT/'private/campaign-v5.py'))
helpers['verify_identity']()
session=json.loads((ROOT/'private/session.json').read_text())
deadline=datetime.datetime.fromisoformat(session['deadlineUTC']).timestamp()
assert deadline-time.time()>400,'Insufficient approved time for supplemental workflow and cleanup'
label='m7-presentation-fault';state=ROOT/'state'/label;out=ROOT/'captures'/label
state.mkdir();out.mkdir()
before_result=helpers['call'](['defaults','export','local.lawsmith','-'],check=False)
before=plistlib.loads(before_result.stdout) if before_result.returncode==0 else None
backup=ROOT/'private'/f'{label}-preferences-before.plist'
if before is not None:backup.write_bytes(before_result.stdout)
mode=helpers['call'](['osascript','-l','JavaScript',helpers['DISPLAY'],'get']).stdout.decode().strip()
script=ROOT/'private/presentation-fault.zsh'
record={'scenario':label,'applicationSourceSha':helpers['SOURCE'],'nativeHarnessSha':helpers['HARNESS'],'evidenceSourceHead':helpers['HEAD'],'packagedExecutableSha256':helpers['EXPECTED'][str(Path(helpers['EXE']).relative_to(helpers['REPO']))],'supplementalHarnessSha256':hashlib.sha256(script.read_bytes()).hexdigest(),'supplementalDriverSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'startedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat()}
env=os.environ.copy();env.update(QA_STATE=str(state),QA_OUT=str(out),QA_IDLE='15',APP=str(helpers['APP']))
start=time.time();maximum=min(450,int(deadline-time.time()-45));record['timeoutSeconds']=maximum
print(json.dumps({'started':label}),flush=True)
with (out/'scenario.log').open('w') as log:
    proc=subprocess.Popen(['zsh',str(script)],cwd=helpers['REPO'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    record['ownedProcessGroup']=proc.pid
    try:code=proc.wait(timeout=maximum)
    except subprocess.TimeoutExpired:
        record['timedOut']=True;os.killpg(proc.pid,signal.SIGTERM)
        try:code=proc.wait(timeout=5)
        except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);code=proc.wait()
record.update(exitCode=code,elapsedSeconds=time.time()-start,finishedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat())
(out/'outcome.json').write_text(json.dumps(record,indent=2)+'\n')
record['cleanup']=helpers['cleanup'](out,state,proc.pid,mode,before,backup)
(out/'outcome.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record),flush=True)
print('\n'.join((out/'scenario.log').read_text().splitlines()[-10:]),flush=True)
helpers['verify_identity']()
raise SystemExit(0 if code==0 else 1)
