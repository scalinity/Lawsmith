# Stages the fixtures m2-files and m2-guard expect under a fresh QA state directory (their headers
# list them): scenes/bad-*.lawsmith.json, a 1 MiB volume filled to capacity at full/ holding
# on-full-disk.lawsmith.json (reached through scenes/on-full-disk-link.lawsmith.json, with a pristine
# copy beside it), a recovery directory without write permission, and scenes/calibration.lawsmith.json.
# Usage: zsh scripts/verify/native/m2-stage.zsh FILES_STATE GUARD_STATE
#        after the run: hdiutil detach FILES_STATE/full
set -e
REPO=${0:A:h:h:h:h}
SCENE=$REPO/src/scenes/falling-stream.lawsmith.json
F=${1:?files state directory}
G=${2:?guard state directory}
mkdir -p $F/scenes $G/scenes

python3 -I - $F/scenes $SCENE <<'PY'
import json, pathlib, sys
scenes, base = pathlib.Path(sys.argv[1]), json.loads(open(sys.argv[2]).read())
def write(name, mutate):
    v = json.loads(json.dumps(base)); mutate(v); (scenes / name).write_text(json.dumps(v, indent=2))
write('bad-unknown-capability.lawsmith.json', lambda v: v['requiredCapabilities'].append('primitive.unknown.v9'))
write('bad-zero-rotation.lawsmith.json', lambda v: v['semantic']['fields'][0]['pose'].__setitem__('rotation', [0, 0, 0, 0]))
(scenes / 'bad-not-json.lawsmith.json').write_text('{ "format": "lawsmith.scene", not json')
(scenes / 'bad-latin1.lawsmith.json').write_bytes(json.dumps(base).replace('Falling stream', 'Café stream').encode('latin-1'))
(scenes / 'bad-oversized.lawsmith.json').write_bytes(b' ' * (5 * 1024 * 1024 + 1))
PY

cp $SCENE $F/on-full-disk.original.json
hdiutil create -size 1m -fs HFS+ -volname LawsmithFull -quiet $F/full.dmg
mkdir -p $F/full
hdiutil attach $F/full.dmg -mountpoint $F/full -nobrowse -quiet
cp $F/on-full-disk.original.json $F/full/on-full-disk.lawsmith.json
dd if=/dev/zero of=$F/full/filler bs=4096 2>/dev/null || true
ln -sf $F/full/on-full-disk.lawsmith.json $F/scenes/on-full-disk-link.lawsmith.json
mkdir -p $F/recovery-readonly && chmod 555 $F/recovery-readonly
cp $SCENE $G/scenes/calibration.lawsmith.json
print "staged: $(ls $F/scenes | wc -l | tr -d ' ') files for m2-files, free on full/: $(df -k $F/full | awk 'NR==2 {print $4}') KB; calibration scene for m2-guard"
