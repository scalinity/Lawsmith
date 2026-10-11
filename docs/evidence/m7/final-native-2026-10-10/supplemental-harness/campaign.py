from pathlib import Path
import datetime, fcntl, hashlib, json, os, plistlib, re, signal, subprocess, sys, time

ROOT = Path(__file__).resolve().parent.parent
REPO = Path('<checkout>')
APP = REPO/'src-tauri/target/release/bundle/macos/Lawsmith.app'
EXE = str(APP/'Contents/MacOS/lawsmith')
DISPLAY = str(REPO/'scripts/verify/native/display.js')
SOURCE = '0c7c5a7cab60fd6b926c0009deebf832630f9c71'
HARNESS = 'dfdf5158918762b1577624053447ae0f7e8c716b'
HEAD = '6bc4bdf08f09d5cf06cbbdb42be44a35b7a1bc22'
EXPECTED = json.loads((REPO/'docs/evidence/m7/r1-panel-2026-10-10/repaired-build-hashes.json').read_text())['hashes']

def call(args, check=True):
    return subprocess.run(args, capture_output=True, check=check)

def emit(value):
    print(json.dumps(value), flush=True)

def verify_identity():
    assert call(['git','-C',str(REPO),'rev-parse','HEAD']).stdout.decode().strip() == HEAD
    assert not call(['git','-C',str(REPO),'status','--porcelain']).stdout
    call(['git','-C',str(REPO),'diff','--exit-code',SOURCE,'HEAD','--','src','tests','src-tauri','package.json','package-lock.json'])
    call(['git','-C',str(REPO),'diff','--exit-code',HARNESS,'HEAD','--','scripts/verify/native'])
    for name, expected in EXPECTED.items():
        assert hashlib.sha256((REPO/name).read_bytes()).hexdigest() == expected, name

def process_rows():
    result=[]
    for row in call(['ps','-axo','pid,pgid,comm']).stdout.decode().splitlines()[1:]:
        parts=row.strip().split(None,2)
        if len(parts)==3: result.append((int(parts[0]),int(parts[1]),parts[2]))
    return result

def cleanup(out, state, group, original_mode, before, backup):
    owned=set()
    for p in out.glob('*.log'):
        owned.update(int(v) for v in re.findall(r'launched pid (\d+)',p.read_text(errors='replace')))
    terminated=[]
    for pid,pgid,comm in process_rows():
        if (pid in owned and comm == EXE) or (pgid == group and pid != os.getpid()):
            try: os.kill(pid,signal.SIGTERM);terminated.append({'pid':pid,'command':Path(comm).name})
            except ProcessLookupError: pass
    time.sleep(.8)
    with open('/private/tmp/mac-gui-automation.lock','a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        dimensions,hz=original_mode.split('@');w,h=dimensions.split('x')
        call(['osascript','-l','JavaScript',DISPLAY,'set',w,h,hz])
        call(['defaults','delete','local.lawsmith'],check=False)
        if before is not None: call(['defaults','import','local.lawsmith',str(backup)])
        restored=call(['defaults','export','local.lawsmith','-'],check=False)
        actual=plistlib.loads(restored.stdout) if restored.returncode==0 else None
        assert actual==before, 'preferences restoration mismatch'
        mode=call(['osascript','-l','JavaScript',DISPLAY,'get']).stdout.decode().strip()
        assert mode==original_mode, 'display restoration mismatch'
        fcntl.flock(lock,fcntl.LOCK_UN)
    remaining=[{'pid':pid,'command':Path(comm).name} for pid,pgid,comm in process_rows() if (pid in owned and comm==EXE) or pgid==group]
    assert not remaining, remaining
    receipt={'displayRestored':mode,'preferencesRestored':True,'sharedGUIUnlocked':True,'ownedProcessesRemaining':remaining,'terminatedOwnedProcesses':terminated}
    (out/'cleanup.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt

def scenario(name, cap, expected_seconds):
    session=json.loads((ROOT/'private/session.json').read_text())
    deadline=datetime.datetime.fromisoformat(session['deadlineUTC']).timestamp()
    if deadline-time.time()<expected_seconds+60:
        emit({'scenario':name,'disposition':'PENDING','reason':'insufficient approved time for complete scenario and cleanup'});return False
    verify_identity()
    label=name if not name.startswith('/') else 'm7-visual'
    state=ROOT/'state'/label;out=ROOT/'captures'/label
    state.mkdir(exist_ok=True);out.mkdir(exist_ok=False)
    prefs=call(['defaults','export','local.lawsmith','-'],check=False)
    before=plistlib.loads(prefs.stdout) if prefs.returncode==0 else None
    backup=ROOT/'private'/f'{label}-preferences-before.plist'
    if before is not None: backup.write_bytes(prefs.stdout)
    mode=call(['osascript','-l','JavaScript',DISPLAY,'get']).stdout.decode().strip()
    if label=='m2-files':
        guard=ROOT/'state/m2-guard'
        with (ROOT/'private/file-stage.log').open('w') as log:
            call_result=subprocess.run(['zsh','scripts/verify/native/m2-stage.zsh',str(state),str(guard)],cwd=REPO,stdout=log,stderr=subprocess.STDOUT)
        assert call_result.returncode==0, 'M2 fixture staging failed'
    env=os.environ.copy();env.update(QA_STATE=str(state),QA_OUT=str(out),QA_IDLE='15',APP=str(APP))
    maximum=min(cap,int(deadline-time.time()-45))
    start=time.time()
    record={'scenario':label,'applicationSourceSha':SOURCE,'nativeHarnessSha':HARNESS,'evidenceSourceHead':HEAD,'packagedExecutableSha256':EXPECTED[str(Path(EXE).relative_to(REPO))],'startedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'timeoutSeconds':maximum}
    emit({'started':label,'expectedSeconds':expected_seconds})
    with (out/'scenario.log').open('w') as log:
        cmd=['zsh',name] if name.startswith('/') else ['zsh','scripts/verify/verify.sh','native',name]
        proc=subprocess.Popen(cmd,cwd=REPO,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        record['ownedProcessGroup']=proc.pid
        try: code=proc.wait(timeout=maximum)
        except subprocess.TimeoutExpired:
            record['timedOut']=True
            os.killpg(proc.pid,signal.SIGTERM)
            try:code=proc.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);code=proc.wait()
    record.update(exitCode=code,elapsedSeconds=time.time()-start,finishedAtUTC=datetime.datetime.now(datetime.timezone.utc).isoformat())
    (out/'outcome.json').write_text(json.dumps(record,indent=2)+'\n')
    try: record['cleanup']=cleanup(out,state,proc.pid,mode,before,backup)
    except Exception as error:
        record['cleanupError']=str(error);emit(record);raise
    if label=='m2-files':
        mount=state/'full'
        call(['hdiutil','detach',str(mount)])
        record['ownedFullDiskVolumeDetached']=True
    (out/'outcome.json').write_text(json.dumps(record,indent=2)+'\n')
    emit(record)
    print('\n'.join((out/'scenario.log').read_text(errors='replace').splitlines()[-8:]),flush=True)
    verify_identity()
    return code==0

SCENARIOS=[('m7-compare',650,440),('m7-perf',360,265),(str(ROOT/'private/short-visual.zsh'),170,120),('m7-r1-panel',750,600),('m6a-record',390,310),('m6a-guard',330,190),('m6a-legible',200,85),('m6a-pace',300,145),('m6b-seek',360,235),('m6b-long',420,285),('m4-perf',670,515),('m3-p1',420,275),('m5-compose',550,480),('m5-legible',220,85),('m5-perf',420,275),('m2-files',420,195),('m2-guard',460,315)]

if __name__=='__main__':
    for args in SCENARIOS:
        if not scenario(*args):
            emit({'campaign':'STOPPED','affectedScenario':args[0],'policy':'retain failure and classify before any retry'});sys.exit(1)
    emit({'campaign':'ALL_SCHEDULED_SCENARIOS_EXIT_ZERO'})
