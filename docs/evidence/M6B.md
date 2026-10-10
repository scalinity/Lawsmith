# M6B qualification record

**Status:** ACCEPTED by the owner on 2026-10-10 (America/New_York), on the independent complete-state review and its bounded remediation verification (Review; Owner acceptance), and merged to `main`. The accepted application code is `66bd5bf14e3458ea88a970a9741d2fa9087eec74`; the published remediation and evidence head was `4fbb1a65c77a67065c3a6196458debcc56f891df`. The review found AC5 failing on two defects that let the displayed replay change while a seek was pending. Both are fixed, and every M6B check passed again headless and in the packaged repaired app (Acceptance criteria). By a bounded owner exception, the M6A, M1–M5 and P0–P2 native results carry forward from `d6966fd`, where they ran (Owner acceptance).
**Candidate:** branch `m6b`, application code at commit `66bd5bf`. Its M6B native results ran on the packaged app built from it at 20:47:53–20:48:08 on 2026-10-09 (Evidence provenance). `d6966fd`, the reviewed code, differs from it only in `src/main.ts` (the pending-seek play path and the Shift+C fixture) and `src/simulation/contexts.ts` (`advanceReplay`'s pending-seek guard). The M6A, M1–M5 and P0–P2 native results ran on `d6966fd` and were not re-run on `66bd5bf`. The later commits change only `scripts/verify/`, `docs/` and `ORCHESTRATION.html`. Base: `321d9e1` (M6A accepted and merged, application code `2c79d2d`, on `main`, unchanged throughout).
**Scope:** M6B only. **M7 NOT STARTED.**

**Restore a complete checkpoint, replay forward, and land exactly where uninterrupted replay lands.**

- **What a checkpoint holds.** It is the engine snapshot plus every future-affecting value the host holds beyond it. It is captured in one synchronous call between steps, at `settled-before-lifecycle`. It is keyed by run, history context, consumed prefix, simulation semantics, runtime and exact `(tick, cursor)`.
- **How a seek runs.** It restores the closest eligible checkpoint into a new world out of sight, or rebuilds from the root through M6A's `LinearReplay`. It replays forward in batches of about 8 ms, and only the latest request's world replaces the displayed replay, once it holds the target exactly.
- **While a seek is pending the displayed replay holds still.** Play and Space only toggle playing from the target, and nothing advances the displayed replay, not even a partly applied group of commands.
- **Packaged app, lab recording.** The seek scenario played on from every kind of seek. Each of the 12 replay checkpoints it logged equals the live recording's digest at the same address, 9 of them from worlds a seek restored from a checkpoint.
- **Packaged app, the in-app fixture (Shift+C).** It compared 47 targets on the lab recording and 46 on a 60 s P1 recording with M6A's checkpoint-free replay, state and engine bytes, and found no difference. On both, Play and Space pressed during long seeks left the displayed replay unchanged and paused, Cancel left it paused, and a commit played on from the target.
- **Latency gate.** Cached seeks on that P1 recording reached the first drawn frame at p95 182 ms, against a 250 ms gate. An uncached rebuild of all 7,200 steps ran in batches of 8 ms (p95) and showed its progress and Cancel after 112 ms.

## Environment

| Item | Value |
| --- | --- |
| Machine | Apple M5 Pro, 48 GiB, arm64. Built-in display at its Larger Text scale (1168×755 pt, 120 Hz), switched to 1728×1117 pt only for `m6a-legible`, `m6a-pace`, `m4-perf`, `m3-p1`, `m5-legible` and `m6b-long`, each restoring it. Normal power mode, on AC |
| macOS | 27.2, build 26B5091g, as the app reports it |
| WKWebView / WebKit | `22625.2.5.11.1` from `AppHandle::webview_version()`; origin `tauri://localhost`, secure context; backend WebGPU |
| Toolchain | Node 26.10.0, npm 12.2.0, rustc/cargo 1.99.0 (`rust-toolchain.toml`) |
| Tauri family, frontend packages | Unchanged from M6A: `git diff 321d9e1..HEAD` touches no `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` or toolchain pin. The app reports `tauri 3.0.0-alpha.4; tauri-runtime 3.0.0-alpha.3; tauri-runtime-wry 3.0.0-alpha.4; wry 0.57.0; tao 0.37.1` |
| Simulation profile, kernel, run format | Profile `lawsmith-m1-rapier-0.21.0`, kernel `affine-ak-v2`, Rapier 0.21.0 and its WASM SHA-256 `17cfa80e…dd4b`: unchanged. A restored world's eight effective parameters are checked against the profile on every restore. The run format stays `lawsmith.run` schema 2 |
| Bundle (candidate `66bd5bf`, built from `caba623` 2026-10-09 20:47:53–20:48:08; the counted `m6b-seek` and `m6b-long`) | `Lawsmith.app`, 14 MB. SHA-256: `dist/assets/index-D25RU-Ve.js` `3dd2f808087376f34c78b28f9677e89fad56c4d2fc1457e63761a62153d72b09`, `index-X1uorxkK.css` `068b946f73f1151bc04b1e3bf08f5839a22a3355f1e5333e137f78e7119b9814` (unchanged), `index.html` `dfc699a750b5b824056a648ea03fd74ef399892ffcbbc98bd24133685ee99fc1`, shell binary `Contents/MacOS/lawsmith` `8763db13d179ef0a0cd6d93bf1f67156fa9d9022e8bb7c3401880341eb6de2e7` (it embeds the frontend). The packaged app's own identity reports the bundle as `index-D25RU-Ve.js sha256:3dd2f808…`, the same bytes |
| Bundle (reviewed `d6966fd`, built 2026-10-08 23:16:39–23:17:05; the M6A, M1–M5 and P0–P2 runs) | `index-BiDBAne9.js` `a0c4f337ff9e92ae8b7e25e8b06aaa9771529a9a093cd3f64bf16220dc3900ec`, the same CSS, `index.html` `bdc1b00a4c96e2218b29066206ecdf0a5adc1072064abd9fff91ff49faf226de`, shell binary `20448332a981014a3f7aaf0e4796a406db8a17f8ab920c8750567745141ce648` |

## Commands and outcomes (candidate)

| Command | Outcome |
| --- | --- |
| `npm ci` | exit 0; `fsevents` install scripts blocked, as expected |
| `npm run typecheck` | exit 0 |
| `npx vitest run` | 30 files passed, 3 opt-in measurement files skipped: **638 tests passed, 3 skipped**. That is M6A's 591, unchanged, plus 47 new: `checkpoints` 28, `seek` 18, `workflow` 1 |
| `(cd src-tauri && cargo test)` | **27 tests passed**, as M6A (no Rust change) |
| `(cd src-tauri && cargo check)` | exit 0 |
| `npm run build` (within `npx tauri build`) | exit 0; the chunk-size warning of M1–M6A |
| `npx tauri build --bundles app` | exit 0; `Lawsmith.app`, 14 MB |
| Fault-injection strings (`rapier-hang`, `LAWSMITH_FAULT`) in `dist/assets` | absent |
| `VITE_LAWSMITH_MEASURE=1 npx vitest run tests/seekCost.test.ts --silent=false` | exit 0 on `d6966fd`; `m6b/seek-cost-headless.log` (Seeking). Its path has no pending-seek play request or frame, so the fixes do not reach it |
| Native scenarios, M6B (packaged `66bd5bf`) | `m6b-seek` 18 checks, `m6b-long` 12. Each exited 0 with no failed check (Evidence provenance) |
| Native scenarios, the rest (packaged `d6966fd`, not re-run; carried forward by the owner's exception, Owner acceptance) | M6A, carried: `m6a-legible` 7, `m6a-record` 35, `m6a-guard` 19, `m6a-pace` 3. M1–M5 regression: `m5-compose` 37, `m5-legible` 3, `m4-trails` 6, `m4-perf` 13 (P0, P2), `m3-p1` 6 (P1), `m4-explain` 28, `m3-handles` 43, `m3-demo` 26, `m2-demo` 14, `m2-authoring` 20, `m2-files` 19, `m2-guard` 36. Every counted run exited 0 with no failed check |

## Implementation

| Module | Holds |
| --- | --- |
| `src/simulation/host.ts` | `checkpoint()`: the engine snapshot and the sidecar in one synchronous call at a settled boundary; `new SimulationHost(root, checkpoint)`: a new world from `World.restoreSnapshot`, every lookup rebuilt from the sidecar and checked against the restored world and the root; `HostCheckpoint`, `BodyHandleMapping`, `BodyLifetime`, `EmitterRuntimeState`, `ColliderIdentity`, `CheckpointRejected` |
| `src/simulation/checkpoints.ts` (new) | `Checkpoint` (the sidecar and its key: run, history context, consumed-prefix identity, simulation fingerprint, runtime identity, address, size, checksum); `captureCheckpoint`; `intact`; `PrefixIdentities`; `onPath`; `ineligible`; `CheckpointCache` (64 MiB, 16 MiB each, least recently used first); `RestoredReplay`, forward replay from a restored checkpoint with its own logic; `CHECKPOINT_TICKS` 240 |
| `src/simulation/contexts.ts` | The coordinator owns the cache: a capture right after each replay step onto a 240th tick; `scope(record)` (a history context per record, its prefix identities, this build's fingerprint and runtime); `seek`, `seekWork`, `cancelSeek`, `seeking`, `seekProgress`: a latest-wins seek job that reconstructs out of sight and replaces the displayed replay only at its exact target; every context change cancels it; while one is pending `advanceReplay` advances nothing, not even a unit cut short; a dropped or replaced record takes its checkpoints with it; `counts()` adds the seek world and the cache |
| `src/simulation/replay.ts` | Unchanged: `LinearReplay`, the checkpoint-free oracle |
| `src/main.ts`, `index.html`, `src/style.css` | The replay timeline (moving it requests tick n after its included commands); the seek request; its batch pump, each batch its own task within 8 ms; progress, a progressbar and Cancel seek after 100 ms. Escape, Step, a file dialog, a busy workflow and every context change end a pending seek. During a seek the displayed replay stays paused: Play and Space toggle playing from its target once it commits, and the button shows that request. A commit shows its world paused with fresh views, keeps the explained body if it lives there, and says when trails start again. `seek` events report each request, superseding, cancel, commit and first drawn frame; `checkpoint` events report captures and rejections. Shift+C runs M6B's fixtures in the app |
| `src/persistence/workflow.ts` | Open Recording quiets the app again after the panel, before building its candidate, so a seek's world never sits beside it |
| `tests/` | `checkpoints` 28, `seek` 18, `workflow` +1, `seekCost` (opt-in); `tests/support/run.ts` `interventionRecord` |
| `scripts/verify/native/` | `m6b-seek`, `m6b-long`, `m6bq.py` (`checkpoints`, `seeks`, `retained`, `latest`, `deferred`), `logq.py timeline` |

No dependency, engine, profile, run format or M6A run semantic changed. The run file stays `lawsmith.run` schema 2. `LinearReplay` and the M6A test "production replay restores no snapshot" are untouched.

## The complete sidecar (SPEC §14.1; MILESTONES M6B In scope)

Every value `SimulationHost` holds, and where a restored world gets it. "Root" is the record's frozen root, which the restored world shares by construction.

| Host state | Affects a later step | In a checkpoint |
| --- | --- | --- |
| The Rapier world | yes | `engineBytes`: bodies and colliders with their shapes, materials, groups and mass, poses, velocities, islands, broad phase, narrow-phase contact manifolds with their warm-start impulses, integration parameters, gravity (zero), arena handles and free lists. The restore checks the profile's eight effective parameters and zero gravity on the restored world |
| Body and emitter definitions, `maxLiveBodies`, `maxAppliedAcceleration`, profile | yes | root |
| `live`: the settings in force | yes, `setAmbient` changes the ambient acceleration | `ambientAcceleration`; the rest from the root |
| `tick`, `lastAppliedSequence` | yes | the address |
| `fieldDefs` | yes | `activeFields`, in stable ID order |
| `compiled` | derived | recompiled from `activeFields` |
| Emitter PRNG and spawn ordinal | yes | `emitterStates` |
| Emitter schedule (next birth) | derived from the definition, the tick and the ordinal (`due`); no separate state | — |
| Living dynamic bodies: membership, order, handles, radius | yes: lifecycle, the live-body limit, the published order | `bodyIdentityMap`, in the host's order (authored by ID, then emitted in spawn order) |
| Body death ticks | yes | `bodyLifetimes` |
| `colliderIds`: every collider's body, fixed ones included | names contact partners in explanations | `colliderIdentity` |
| `skippedEmissions` | a lifecycle count, observed | `skippedEmissions` |
| `maxSpeed`, `limitedSteps` | diagnostics a step leaves | carried, so a restored world reports what the uninterrupted one does |
| `pending`, `acks` | would be consumed next | must be empty: capture refuses otherwise |
| `halted`, `recorder` | a live recording at a limit | capture refuses a halted host; replays never record |
| `fault` | stops every step | capture refuses a faulted host |
| `positions`, `radii`, `ids`, `count` | published | rebuilt by `publish()` |
| `generation` | identity of the world, not state | a new value: views of the old world clear |
| `explainId`, `explanation` | UI choice, per-world observation | not captured; the app clears the choice at every switch, and a new world has no explanation until it steps |
| `forces`, `sample`, `accel`, `force`, `explainSamples`, `explainState` | scratch, written before each read | fresh |
| `lastFieldMs`, `lastEngineMs` | timings | not captured |

Every captured component is load-bearing: `tests/checkpoints.test.ts` restores the 720 checkpoint with each one changed (the PRNG state, the ordinal, a lifetime, the ambient acceleration, a law removed, the skipped count, the order of bodies, the diagnostics) and the comparison finds each at once, naming its entity and component. A changed radius, collider name or handle is refused by the restore itself, which checks them against the restored world.

## The phase (SPEC §14.1)

`SimulationHost.step()` runs: settle the queued commands at n, stop if halted, check the clock, lifecycle at n (expire bodies with `deathTick ≤ n` by ID, then spawn due bodies by emitter), forces from the start-of-step state, the engine step, the post-step checks, n + 1, publish. Between two steps, with nothing queued, the host is at `settled-before-lifecycle`: commands drained, lifecycle for the current tick not yet run, lifetimes for every earlier tick done. `checkpoint()` captures there in one synchronous call (snapshot and sidecar together, nothing else can run in between) and refuses anywhere else.

A replay captures right after its step onto a 240th tick, before that boundary's recorded commands: the address `(240k, cursor before 240k's commands)`, the earliest at that tick, so it serves every target there. At 720 in the fixture a body dies and another is born in the lifecycle the next step runs; restored there, the commands at 720 apply first, then that step expires the one and spawns the other, once each.

## Keys and eligibility (SPEC §14.2; AC3)

A checkpoint serves a target only if all hold (`ineligible`):

1. The same run ID.
2. The same history context. Each record gets its own when first replayed (`record-n`); its replays, restarts and seeks share it. A live, imported-again or alternate context never does.
3. The same simulation fingerprint and runtime identity, as canonical text.
4. Its address is on the record's path: the commands through its cursor lie at or before its tick, the next one at or after it.
5. Its consumed-prefix identity is the record's at that cursor: FNV-1a 64 over the run ID, the root's canonical text and the canonical text of commands 1…cursor.
6. Its address is at or before the target, tick first, then cursor. A later cursor at the same tick is after.

The closest eligible one is restored. With none, the seek rebuilds from the root through M6A's `LinearReplay`.

## Restored versus linear (AC1, AC2)

The oracle is `LinearReplay`, unchanged from M6A: a world built from the frozen root, each recorded command applied once at its boundary, no snapshot restored. The restored side is `RestoredReplay`: a world from a checkpoint, then the same record's later commands by its own forward logic. They share the host's command interpretation and step, which M6A accepted, and nothing else. The comparison is M6A's `observe`/`firstDivergence` (address, laws, settings, emitters, bodies by stable ID, engine bytes) plus what the host publishes beyond it: body order, radii and positions as rendered, the diagnostics, and the explained body's retained transition with its contact partners named. None of it is checkpoint code.

The fixture (`tests/support/run.ts` `interventionRecord`) is the laboratory scene over 1,100 ticks. The stream is born every 8th tick and its bodies die from tick 512, so births, deaths and contacts with the floor run through the four 240-tick checkpoints. It holds:

- a drag over five boundaries;
- an ambient change at 300;
- three paused edits at 500;
- two at 720, a checkpoint tick with a death and a birth due;
- a law created at 800 and removed at 900;
- two edits at the final tick.

| Case (`tests/checkpoints.test.ts`, `tests/seek.test.ts`) | Result |
| --- | --- |
| From each checkpoint a paced replay captured (240, 480, 720, 960), restored, then forward unit by unit to the frozen end | equal at every boundary to the end (at least 1,100 − T units from tick T), with a stream body on the floor explained on both sides |
| At 720's own birth and death boundary | the commands at 720 first, then one step expires the dying body and spawns `stream:90`, once each; ordinal 91; equal to the end |
| From addresses no 240th tick reaches: tick 1, a death tick, (500, before), each cursor between the three commands at 500, (500, through), the final tick before and after its commands | equal to the end from each |
| A zero-duration recording, restored at each tick-zero cursor 0–3 | equal, with no step |
| A restore of a restored world, with the first world freed before the second steps | equal to the end |
| Through the coordinator: 44 targets in a fixed shuffle (between checkpoints, between same-tick commands, at a death tick, 239/240/241, 959/961, the final boundary before, between and after its commands, 24 random ticks) | each equal to the oracle at its address; the first rebuilt from the root, more than half restored from a checkpoint; no source ever after its target |
| Playing on from a seek's result to the end | equal; the replay's own end check matches the recorded final digests |
| A zero-duration recording through the coordinator, cursors 3, 1, 2, 0 | each equal, tick 0 |

Negative controls (the sidecar audit above): each changed component of the 720 checkpoint is caught by the comparison at once, naming it. A changed radius, collider name, collider handle, or another tick's engine bytes is refused by the restore. A cursor off the record's path is refused by `RestoredReplay`.

## Seeking (AC3, AC5–AC9)

| Case (`tests/seek.test.ts`, `tests/checkpoints.test.ts`) | Result |
| --- | --- |
| Eligibility: another run, history context, fingerprint, runtime, prefix, an address after the target, off the path | each refused with its reason |
| A later cursor at the same tick | never serves the earlier target; the nearest earlier checkpoint does |
| A live checkpoint after the stop, at the stopped address or after a further edit | another history context; rekeyed into the record's, the later cursor lies off its path |
| Prefix identities | equal for equal content, different from the first changed command on |
| A newer request while an older one works | the older world freed at once; only the newer commits; the displayed replay unchanged until then, and its world freed at the commit |
| Six rapid requests, then Return to authoring | nothing commits; one world (authoring); the authoring host, scene object, revision, applied revision, generation, undo, redo, state and engine bytes identical |
| Replay from start, an imported recording, a dropped record | each cancels the pending seek and frees its world |
| Cancel | frees the reconstruction; the displayed replay's state and engine bytes identical |
| A seek requested while the displayed replay is cut short midway through a 130-command same-tick group, at (0, 64) | paused and playing frames leave its cursor, observation and engine bytes unchanged; canceled, the group finishes from (0, 64); replaced, the seek's world shows exactly (0, 120), equal to the oracle. Without the guard the first paused frame finishes the group |
| An uncached seek to the end with a clock bounding batches | more than 100 batches, each stopping at its deadline (within its bookkeeping), progress monotonic, nothing displayed before the commit |
| A checkpoint's byte changed in the cache | caught by the checksum before `World.restoreSnapshot` is called (a spy sees no call); the record's cache discarded; rebuilt from the root, exact; the seek recaptured fresh checkpoints |
| Checkpoints keyed to another runtime | never used; rebuilt from the root, exact; `replayQualified` unchanged |
| A cached seek | calls `World.restoreSnapshot` once; Replay from start and paced playback call it never (M6A's test "production replay restores no snapshot" still passes, unchanged) |
| Trails across a seek | the displaced world freed, a new generation, trails cleared at the first sync |
| T11: 20 cycles of seek, superseded seek and cancel, seek, Replay from start, a pending seek, Return | every cycle ends with the same world count, the same 4 checkpoints and the same cache bytes; at most 3 worlds at once (authoring, displayed replay, one reconstruction) |
| AC9: ten seeks, a cancel, Return | the authored scene, revision, generation, undo, redo and the retained world's state and engine bytes identical; selection, record, export flag and recording state unchanged |
| The cache | 64 MiB and 16 MiB limits; bytes = engine bytes + sidecar UTF-8; least recently used evicted first, using a checkpoint refreshes it; one over the individual limit declined; eviction and discard leave the record's exported text byte-identical |

**Headless cost** (`tests/seekCost.test.ts`, opt-in; Node 26's V8, not WKWebView; [m6b/seek-cost-headless.log](m6b/seek-cost-headless.log)). On a P1 recording of the full 60 s with a drag every 12 ticks (7,200 ticks, 600 commands):

- A checkpoint is 389,553 bytes, 356,022 of them engine bytes. The 30 checkpoints hold 11.7 MB.
- A restore takes p50 0.48 ms and p95 0.96 ms.
- An uncached seek to the end takes 5.38 s in 630 batches.
- 100 seeded cached seeks take p50 100 ms, p95 170 ms and max 185 ms, forwarding p50 129 and p95 226 steps.

An earlier run of the same measurement read p95 394 ms while a reviewer agent's test runs shared the CPU. Unloaded, the seek loop costs 0.76–0.80 ms per step, the same as plain linear replay, so that figure is discarded.

## In the packaged app: seeking a real intervention (`m6b-seek`; AC1, AC2, AC4, AC5, AC8, AC9)

Packaged `66bd5bf`, the M6A lab scene (`scripts/verify/scenes/m6a-lab.lawsmith.json`). Real gizmo drags, clicks on the timeline, keys and a real quit. `m6bq.py` reads the session's log in order with its own code.

| Step | Native result |
| --- | --- |
| The recording | tick 0 to 3131: the push dragged across the stream while it played (one gesture, its 24 samples on many boundaries), the Storm Bottle disabled and enabled, two paused edits at the final tick; 28 commands, stopped by the user, with a final check |
| Replay | a timeline over the whole recording (max 3131, at 0) |
| Seek before the intervention (timeline) | committed at (318, 0), rebuilt from the root out of sight (nothing cached yet), 318 steps, 25 ms; the replay shows exactly that address, paused, read-only |
| Played through the intervention, then forward to its result | (2085, 24) from the checkpoint at (960, 0), 1,125 steps, 190 ms |
| Back before it | (473, 0) from the checkpoint at (240, 0), 233 steps, 32 ms |
| Trails | 32 trails stored and drawn while the replay played; after a seek to (1922, 24) none stored or drawn, and the status said "Trails start again from here."; steps rebuilt them and the note went |
| Scrubbing the timeline | 20 requests, each commit the newest request at its moment, the last one shown (`m6bq latest`). On this light scene each cached seek (4–38 ms) ended before the next pointer move, so none was superseded; `m6b-long` shows superseding |
| Played on to the end | from (2829, 26), restored from the checkpoint at (2400, 25), to (3131, 28): the replay's own end check matched the recorded final digests, after 25 seeks |
| `m6bq seeks` | 25 requests, 25 commits (1 from the root, 24 from checkpoints), each holding exactly its target |
| Shift+C on this recording | 47 targets (special addresses, every same-tick group's inner cursors, seeded ticks; 7 from the root, 40 restored) equal to the checkpoint-free oracle, state and engine bytes; cached seeks p50 32 ms, p95 34 ms to the drawn frame (a 26 s recording: reported, not gated); uncached 3,131 steps in 44 batches of 8 ms (p95; max 9), progress at 100 ms; a cancel once progress showed, at 101 ms, the displayed replay unchanged. **Play and Space during long seeks** (the review's R1), through their own handlers: every press toggled only the request to play from the target and the button showed it, the displayed replay held still and paused across frames, stayed paused after Cancel, and after a commit played on from exactly the target. 20 seek/reset cycles at 1 world, 13 checkpoints and 1,161,757 bytes after every cycle, peak 3 worlds; geometries 43, textures 5 and scene objects 135 before, after every cycle and after |
| `m6bq retained` | the retained authoring world's 68 digests, at every switch since the replay began (22 entries, 22 Returns, 24 restarts, the fixture's cycles and controls cases included), are identical |
| `m6bq checkpoints`, after Shift+C | every replay checkpoint the session logged equals the live recording's at its address: 3 from a world a seek rebuilt from the root, **9 from worlds a seek restored from a checkpoint** |

Recording: [m6b-seek.mp4](m6b/m6b-seek.mp4) is of the `d6966fd` run (168 s of 170; Evidence provenance); this run's was not published. Captures, this run: [the replay](m6b/seek-01-replay.png), [before the intervention](m6b/seek-02-before-intervention.png), [its result](m6b/seek-03-after-intervention.png), [trails start again](m6b/seek-04-trails-start-again.png), [trails rebuilt](m6b/seek-05-trails-rebuilt.png), [scrubbed](m6b/seek-06-scrubbed.png), [the end](m6b/seek-07-end.png).

## In the packaged app: long reconstructions on P1 (`m6b-long`; AC5, AC7, AC8)

Packaged `66bd5bf`, the P1 workshop at a 1600×1000 CSS viewport under More Space, recorded while a law was dragged until the 60 s limit closed it at tick 7200 (145 commands).

| Step | Native result |
| --- | --- |
| Play pressed twice while a full 7,200-step reconstruction was pending (the review's R1, its own reproduction) | two real clicks on Play, 585 and 913 ms after the request, logged `play-on-commit` then `pause-on-commit` (`control`), and no play of the displayed replay came between the request and the seek's end (`m6bq deferred`). Before the fix the second press started it |
| Return to authoring while that reconstruction was still pending | the seek ended `canceled` with reason `return` at 2,261 ms, after 2,940 of its 7,200 steps from the root, and never committed; one world (authoring); the retained world's state and engine digests, tick, cursor, revision, generation and history equal to those logged when the replay began |
| Cancel seek | in a new replay, a long seek showed its progress and Cancel seek after 100 ms (the status "tick 0 of 7200, change 0 of 145. Seeking to tick 7200, change 145… 16%", the progressbar, the thumb at the target, `worlds 3`); Cancel seek ended it at 1,870 ms, from the checkpoint at (2880, 58); the same replay at tick 0, "Paused.", no seek world, the timeline back at 0 |
| A newer request during a long reconstruction | the long seek, from (4800, 96), superseded after 319 ms; only the newer one, (2156, 48), committed (from (1920, 42), 236 steps, drawn at 192 ms) and is shown (`m6bq latest`: 2 requests, 1 superseded, 1 committed, the last shown) |
| `m6bq seeks` | no superseded or canceled request ever committed (4 requested, 1 committed, 1 superseded, 2 canceled) |
| Shift+C (screen recording off) | 46 targets (6 from the root, 40 restored) equal to the oracle; **cached seeks to the first drawn frame p50 98, p95 182, p99 186, max 186 ms** over 100 seeded targets (to the commit: p95 175 ms; work p95 161 ms; steps p50 120, p95 233); the gate applies (a 60 s recording) and passes. **Uncached** to the end: 7,200 steps in 5.31 s, 604 batches of p50 8, p95 8, p99 13, max 15 ms, progress shown at 112 ms. A cancel once progress showed, at 107 ms, the replay unchanged. **Play and Space during long seeks**: as on the lab recording, every gate held. **20 seek/reset cycles**: 1 world, 30 checkpoints and 11,404,108 bytes after every cycle, geometries 58, textures 5 and scene objects 268 after every cycle and after, peak 3 worlds |

Recording: [m6b-long.mp4](m6b/m6b-long.mp4) is of the `d6966fd` run (its replay section, 38 s); this run's was not published. Captures, this run: [returned](m6b/long-01-returned.png), [progress](m6b/long-02-progress.png), [canceled](m6b/long-03-canceled.png), [superseded](m6b/long-04-superseded.png).

Natively a P1 cached seek's steps run at about 0.71 ms each (the median of work over steps across the 100 seeks; 0.68 ms at the 5th percentile), quicker than the ~1.05 ms they average in interactive play: in the seek loop nothing renders between steps.

## M6A, carried: its four scenarios on this build (AC9; thread "M6A native re-run")

M6A's remediated code (`2c79d2d`) never ran natively before acceptance. Its scenarios ran here on M6B's reviewed build, `d6966fd`, which contains it. They were not re-run on `66bd5bf`. None of them requests a seek, and the fixes change behavior only while one is pending. They carry forward to the accepted `66bd5bf` by a bounded owner exception; by the project's rule a native result otherwise counts only on the build it ran on (Owner acceptance).

| Scenario | Native result |
| --- | --- |
| `m6a-legible` | 7 checks: the content viewport 1280×800 CSS. The recording cluster, now with the timeline, is clear of the panel, tools, transport, switches, explanation and diagnostics in every state, at 1280×800 and at the 900×600 minimum, and nothing scrolls sideways. Its rects (x, y, w, h) at 1280×800: idle 913, 52, 355, 90; recording 1020, 52, 248, 98; recorded 828, 52, 440, 124; replay with the end check 828, 52, 440, 172 (M6A: 154, before the timeline). At 900×600 the replay state reaches y 224 (M6A: 206), over the top of the selected Storm Bottle's projected support (from y 184), which SPEC §11.1 gates at 1280×800 only; M6A finding 4, carried to M8 |
| `m6a-record` | 35 checks: a real intervention recorded to (3653, 31); a fresh launch opened the saved schema-2 run and replayed it to (3653, 31), state `d535df28…`, engine `dce0938e…`, equal to the recording's final check; all 15 live checkpoints equal in the replay; the retained authoring world identical before and after |
| `m6a-guard` | 19 checks: the replay names the law its recording created (`push-2`) as its record carries it, "Push 2", not by its ID; a malformed run, a run of another WebKit and a scene refused from replay, each leaving everything as it was; from replay the scene's alert offered **Save Main Scene**, and the file written holds the authored scene, not the replay's root; no recovery on relaunch |
| `m6a-pace` | 3 checks: P1 at 1600×1000 recorded with drags for 41 s (97 commands), interval p95/p99 18/18 ms, step 2/2, edit p95 19 recording and 17 replaying; the replay matched its recorded end |

## M1–M5 regression

On the reviewed build, not re-run on `66bd5bf`, and carried forward by the owner's exception, as M6A's above.

| Scenario (packaged `d6966fd`) | Result |
| --- | --- |
| `m5-compose` | 37 checks PASS |
| `m5-legible` | 3 checks PASS |
| `m4-trails` | 6 checks PASS |
| `m4-explain` | 28 checks PASS |
| `m3-handles` | 43 checks PASS |
| `m3-demo` | 26 checks PASS |
| `m2-demo` | 14 checks PASS, the M1 oracle and the native reopen's digests as in M6A |
| `m2-authoring` | 20 checks PASS |
| `m2-files` | 19 checks PASS |
| `m2-guard` | 36 checks PASS |
| P0, P1, P2 | Performance (`m4-perf`, `m3-p1`) |

## Performance (AC8; the performance gate)

**P0, P1, P2 on the reviewed build** (packaged `d6966fd`, not re-run on `66bd5bf` and carried forward by the owner's exception: outside a pending seek the fixes add a few field reads per frame and nothing else; SPEC §18.2 protocol as in M2–M6A: a focused window, a 1600×1000 CSS viewport at DPR 2 rendered under the 1.5 cap, recording off, 10 s warmup, 60 s measured, three runs, real drags about every 1.5 s feeding edit latency). p50 / p95 / p99 / max in ms; runs are never averaged:

| Workload | Run | Step | Edit → frame (n) | Frame interval | Frame work | Sim/wall |
| --- | --- | --- | --- | --- | --- | --- |
| P0, the recipe, 64 bodies, 125 arrows | 1 | 0 / 1 / 1 / 1 | 6 / 16 / 17 / 18 (145) | 17 / 18 / 18 / 21 | 1 / 2 / 3 / 3 | 1.000 |
| | 2 | 0 / 1 / 1 / 2 | 6 / 16 / 17 / 17 (146) | 17 / 18 / 18 / 19 | 1 / 2 / 3 / 3 | 1.000 |
| | 3 | 0 / 1 / 1 / 1 | 6 / 16 / 17 / 17 (147) | 17 / 17 / 18 / 18 | 1 / 2 / 3 / 4 | 1.000 |
| P1, 200 colliding bodies, 16 one-leaf laws, 16 fixed colliders | 1 | 1 / 2 / 2 / 3 | 7 / 17 / 18 / 19 (146) | 17 / 17 / 18 / 25 | 3 / 5 / 6 / 7 | 1.000 |
| | 2 | 1 / 2 / 2 / 3 | 8 / 16 / 18 / 18 (140) | 17 / 17 / 18 / 21 | 3 / 5 / 5 / 7 | 1.000 |
| | 3 | 1 / 2 / 2 / 3 | 9 / 17 / 18 / 19 (144) | 17 / 18 / 18 / 25 | 3 / 5 / 5 / 7 | 1.000 |
| P2, 100 bodies, 2,000 probes, 32 trails, 24 arrows | 1 | 0 / 1 / 1 / 1 | 9 / 19 / 21 / 21 (146) | 17 / 18 / 18 / 19 | 4 / 6 / 6 / 9 | 1.000 |
| | 2 | 0 / 1 / 1 / 1 | 9 / 17 / 19 / 20 (145) | 17 / 18 / 18 / 19 | 4 / 6 / 6 / 8 | 1.000 |
| | 3 | 0 / 1 / 1 / 1 | 9 / 18 / 19 / 20 (145) | 17 / 18 / 18 / 18 | 4 / 5 / 6 / 10 | 1.000 |

Every run is valid and meets its gates, at M6A's figures within a millisecond. The limiter never acted.

**Seeking, in the packaged app** (`m6b-long`'s Shift+C; measured apart from pauses and UI animation, from the request to the first frame submitted with the target's world, as edit latency is measured):

| Gate | Target | Measured |
| --- | --- | --- |
| Cached seek in a 60 s recording (P1, 100 seeded targets) | p95 ≤ 250 ms | p95 **182 ms** (p50 98, p99 186, max 186) on `66bd5bf`; p95 209 ms on `d6966fd`, which the review recomputed from its raw samples |
| Uncached work in batches | about 8 ms | p50 8, p95 8, p99 13, max 15 ms over 604 batches (a batch ends after the unit of work that crosses its deadline: one P1 step, or a chunk of commands) |
| Progress and Cancel seek | shown after 100 ms | at 112 ms (P1), 100 ms (lab) |
| Checkpoint cache | ≤ 64 MiB; ≤ 16 MiB each | 30 P1 checkpoints, 11,404,108 bytes; each of the 112 P1 captures 280,504–407,230 bytes (headless: 389,553 for its own recording of the same scene) |
| 20 seek/reset cycles | bounded worlds and cache bytes | 1 world, 30 checkpoints, 11,404,108 bytes after every cycle; peak 3 worlds |

## Acceptance criteria

The owner accepted AC1–AC9 on 2026-10-10 on these results (Owner acceptance). Each row names the build its native evidence ran on; results from `d6966fd` count for `66bd5bf` only by the owner's bounded exception.

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Restore plus forward replay matches uninterrupted checkpoint-free M6A replay exactly at selected `(tick, cursor)` in the qualified app, through contacts, emissions, deaths and field edits | **PASS**, natively on `66bd5bf`; accepted | Shift+C in the packaged app: 47 lab and 46 P1 targets equal in state and engine bytes, 80 of them restored; `m6b-seek`: 9 replay checkpoints from restored worlds equal the live recording's; headless: from each 240th tick and 8 more addresses, equal at every boundary to the end (Restored versus linear) |
| 2 | Targets between intervals; birth/death boundaries and paused revisions once each; final-boundary and zero-duration records | **PASS**, natively on `66bd5bf` and headless; accepted | headless: 720's death and birth exactly once after the restore, each cursor between the commands at 500, the final tick before, between and after its commands, a zero-duration record at cursors 0–3; natively: every inner cursor of the lab recording's same-tick groups, the final boundary before and after its paused edits, ticks between checkpoints |
| 3 | A later cursor at the same tick cannot serve an earlier target; a newer unrecorded live checkpoint cannot serve a stopped recording; keys include record, prefix, context and runtime | **PASS**, headless on `66bd5bf`; accepted | Keys and eligibility; the eligibility, selection and live-checkpoint cases; natively no source was ever after its target (`m6bq seeks`, the fixtures) |
| 4 | Restoring creates a new world and rebuilds its wrappers and maps; old wrappers cannot survive; the retained authoring context stays intact; no position/velocity-only reconstruction | **PASS**, natively on `66bd5bf`; accepted | The sidecar audit; the restore checks every handle, radius and name against the restored world and refuses a mismatch, allocating nothing; a new generation, the displaced world freed, views cleared; natively 68 identical authoring digests; the restore uses engine bytes only, never poses |
| 5 | Superseded results never overwrite a newer target, another replay context or Return; only the latest fully reconstructed target becomes visible; progress explicit | **PASS**, natively on `66bd5bf` (the review's FAIL on `d6966fd`, R1 and R2, fixed); accepted | While a seek is pending the displayed replay changes in no way: Play and Space only toggle playing from the target (Shift+C on both recordings; `m6b-long`'s two real Play clicks, `m6bq deferred`), and no frame advances it, not even a partly applied command group (headless, fails without the guard). `m6b-long`: a long seek superseded, Return while pending, Cancel; `m6b-seek`: every commit the newest request; headless: superseding, rapid seeks then Return, Replay from start, import and drop all cancel |
| 6 | A corrupt compatible cache is discarded and rebuilt from root and log; an incompatible runtime is not repaired or labeled exact | **PASS**, headless on `66bd5bf`; `m6a-guard` on `d6966fd`, carried forward; accepted | a changed byte caught by the checksum before Rapier reads it, the record's cache discarded, rebuilt from the root exactly; checkpoints of another runtime never used, `replayQualified` unchanged; natively no checkpoint was rejected in any run (174 captures in the two `66bd5bf` runs), and a run of another WebKit is refused (`m6a-guard`, on `d6966fd`) |
| 7 | Cache ≤ 64 MiB, one checkpoint ≤ 16 MiB; eviction cannot alter root/log; repeated restore/seek frees worlds and buffers | **PASS**, natively on `66bd5bf`; accepted | the bounded cache cases; natively 20 cycles bounded on both recordings, peak 3 worlds |
| 8 | Cached p95 ≤ 250 ms in a 60 s recording; uncached in ~8 ms batches with progress/cancel after 100 ms; trails rebuild or clear explicitly | **PASS**, natively on `66bd5bf`; accepted | Performance; `m6b-seek` trails |
| 9 | Read-only replay and M6A's Save Scene / Return ownership unchanged; seeking cannot mutate the draft, undo or recovery | **PASS**, natively: `66bd5bf` and, carried forward, `d6966fd`; accepted | `m6bq retained` on `66bd5bf`; M6A's four scenarios on `d6966fd`; headless AC9 case |

## Findings

1. **A click during a short seek reaches the page after that seek ends** (informational).
   - **How WebKit delivers input.** It sends a page one mouse event at a time, each waiting for the page's reply. The seek's batches run as posted-message tasks on the page's event loop.
   - **What it means.** A click needs two round trips. During a cached P1 seek of 100–200 ms, the next click arrived after the seek had committed. Six clicks 25 ms apart became four requests, each committed in turn (`m6b-long` attempts, Evidence provenance).
   - **Long seeks are fine.** During a seek of several seconds, input is handled between batches: two layout readbacks, Cancel seek and Return to authoring all landed mid-seek, and frames held 17–21 ms.
   - **No criterion is affected.** Every commit is the newest request at that moment, and a newer request during a long reconstruction supersedes it.
   - **What it means for scrubbing.** On P1, scrubbing shows intermediate targets in turn rather than skipping them. How that feels on a real trackpad is an owner check.
2. **A corrupt checkpoint could be retried forever without a listener** (fixed, `6b92930`). The rejection path discarded the record's cache only inside the argument of an optional listener call, `onCheckpoint?.({…, discarded: discardHistory(…)})`, which JavaScript does not evaluate when the listener is absent. Headless, with no listener, a corrupt checkpoint was offered again and again. The app installs a listener, so it would not have shown natively. The discard now runs first, whoever listens.
3. **A pre-native review of the app integration found eight issues** (fixed; Review).
4. **The engine restores exactly.** A spike before any code, and every restore since, found the restored world's snapshot byte-identical to the captured one. It stepped identically to the uninterrupted world through births, removals (arena handle reuse) and contacts, and so did a restore of a restored world. Rapier rebuilds its physics pipeline and CCD solver on restore; neither carries state that changes a step.
5. **Harness slips in the first counted attempts** (fixed; the app was right each time; Evidence provenance).
6. **Two machine events stopped attempts before any click.** First, another session's screenshot interface (`screencaptureui`) covered the screen, as in M6A; the owner chose to have it quit. Second, Notification Center covered the screen for more than the 10 s the guard waits out a banner. One later attempt yielded to the owner's input (exit 4), by design.
7. **The independent review found two ways the displayed replay changed while a seek was pending** (fixed; Review R1, R2). R1 came from the pre-native review's S8.
8. **A deferred Play moves the replay cluster's buttons** (informational). With Play pressed during a seek, " Then playing." wraps the status onto a second line at 1600×1000. Replay from start, Return to authoring and Cancel seek drop 17 CSS px, so the pointer may be over a moved button just when Cancel seek is wanted ([capture](m6b/review-then-playing.png), from a discarded attempt on the same build). The pre-native review's F2 kept Cancel seek's own coming and going from moving the row; this is the status line's. No criterion is affected. Whether to keep the status on one line belongs to M8's playback states, as interface polish (Owner checks).
9. **A saturated machine made synthetic clicks arrive late** (QA environment; Evidence provenance). Three `ffmpeg` screen recorders orphaned by an earlier Lawsmith session on 2026-10-06 kept `replayd` near 170% CPU. With another project's Unreal Engine build, the load average reached 30–42. Clicks reached the page after the harness had declared them lost, its resends toggled twice, and the first re-run failed before any seek. With the owner's agreement the three recorders were stopped (`replayd` fell to 2%), and the counted runs waited for that build to end.
10. **A `kp:space` from `cliclick` reached no keydown handler** (harness; unresolved). In a re-run attempt, Space sent while a long seek was pending logged no toggle. No scenario had sent a `kp:` key before; every other key goes through `t:` with modifiers. The app logs no raw key events, so whether WebKit delivered the key to the focused timeline is not established. Space through its handler is covered by Shift+C. Space on a real keyboard with the timeline focused is unverified, and stays open as an owner check and in M8's keyboard criterion.

Carried, not changed by M6B: the clean Dock Quit/logout policy, emitter rotation, panel height, the window jump and the recording controls at the 900×600 minimum (M8; with the timeline the replay cluster now reaches y 224 there, M6A's finding 4 measured 206); startup compile and probes at the work limits (M9); the Tauri dialog patch, the next Tauri/TAO update and DPR across displays; M4's moving-body and M5's Storm Bottle trackpad checks.

## Review

**Pre-native review, before any native run** (one read-only Opus 5.5 code-reviewer over the seek driver in `src/main.ts` at `143df9b` and its use of the coordinator: the parts with no automated coverage). No critical or high finding; one medium, four low, three suggestions. `/address` resolved every one, each committed and pushed separately:

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| F1 | medium | Shift+C's pass gated neither uncached batches, progress at 100 ms, the cancel's outcome nor the 60 s recording; it canceled after a fixed 300 ms; it timed seeks to the swap, not the drawn frame | `d6966fd`: a seek's outcome carries its batch times, when its progress showed and its first drawn frame; Shift+C gates cached latency to that frame on a 60 s recording, ~8 ms batches and progress at 100 ms, and cancels once progress shows |
| F2 | low | Cancel seek sat before Replay from start, so its coming and going moved buttons under the pointer | `750350a`: last in the row |
| F3 | low | `requestSeek` ran while a file workflow was busy, and Open Recording built its candidate without quieting again: four worlds possible | `7fffc32`: refused while busy; `replaceRun` quiesces before its candidate; a test fails without it |
| F4 | low | A seek commit ran a context switch's synchronous snapshot of the retained authoring world inside the measured latency | `0b43497`: `showWorld` refreshes the world; only a context switch adds its reports and digests |
| F5 | low | "Trails start again" showed when no trail could be drawn (the default mode follows the explained body, which the seek cleared) | `7f64608`: the explained body stays if its world holds it; the note shows only for all trails or a kept body |
| S6 | suggestion | Escape on the focused timeline no longer blurred it and did not cancel a seek | `b74d7b4`: Escape cancels a pending seek, then lets go of the timeline |
| S7 | suggestion | The timeline's track was about 1.6:1 against the panel; a small control; progress in text only | `fabb526`: lavender for the played part, tertiary ink for the rest (about 5:1), 24 px; the progressbar carries a seek's progress |
| S8 | suggestion | Play during a seek gave it up and played from the old address | `8def2cb`: Play during a seek plays from its target once it commits; a pause or a lifecycle pause withdraws that |

The reviewer verified `tsc` clean and the 45 T10 cases passing, and found no other path where a superseded or canceled seek could commit or a promise could stay unresolved.

**Independent complete-state review** (MILESTONES M6B Evidence required for review). A read-only Codex review with two specialist reviewers, a debugger and an auditor, of the evidence head `c119e3f` (application code `d6966fd`) against `321d9e1`.

- **Design verdict.** The complete-state checkpoint approach is sound under the M6A oracle. `LinearReplay` is unchanged and independent of checkpoints. Its sidecar audit of every host value found no omitted future-affecting state. Its probes confirmed the structural rejection, the restore exception's fallback without leaking a world, and the root-and-log rebuild.
- **Execution.** It re-ran the suite in an isolated copy: 637 tests, 27 Rust tests, typecheck and `cargo check` all passed. It recomputed the P1 latency percentiles from the 100 raw samples, 108/209/225/225 ms, with p95 209 ms on the 96 checkpoint-backed requests alone, and the P0/P1/P2 percentiles from the nine raw captures.
- **Dispositions.** AC1–AC4 and AC6–AC9 PASS. AC5 FAIL, on two defects that let the displayed replay change while a seek is pending, each reproduced headlessly with the real coordinator.

`/address` resolved both findings and the review's correction to this record, each committed and pushed separately:

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| R1 | critical (high) | **Repeated Play started the old displayed replay during a seek.** The pending-seek interception applied only when the request differed from the deferred intention. Play and Space toggled `scheduler.playing`, which stays false throughout a seek, so a second press repeated the first, fell through and started the displayed replay. Cancel then left it playing from where it had drifted: (0, 0) → (2, 0). The previous review's S8 (`8def2cb`) introduced it | `72957b6`: every play request during a pending seek sets the deferred intention only. Play, Space and the button's pressed state read that intention. Shift+C presses Play and Space through their own handlers during long seeks and gates on the displayed replay holding still and paused, staying paused after Cancel, and playing on from the target after a commit. `m6b-long` (`0a3ac0d`) clicks the real Play twice during its long seek, and `m6bq deferred` checks the log |
| R2 | warning (medium) | **A pending seek kept settling the displayed replay's partly applied same-tick group.** Each paused frame's zero-unit `advanceReplay` finished a unit cut short: (0, 64) → (0, 128) with 130 tick-zero commands | `66bd5bf`: `advanceReplay` advances nothing while a seek is pending and reports the replay's own partial state, so no replay checkpoint is logged at a partial address. Every path that moves the displayed replay goes through it. A seek test (Seeking) fails without the guard |
| R3 | note | The record counted 11 replay checkpoints in the lab log; the log holds 12 | The in-script verdict ran before Shift+C logged a 12th: (240, 0), from a world rebuilt from the root and equal to the live one. Over that whole log (`c119e3f`), `m6bq checkpoints` counts 4 from the root and 8 restored, all equal. `caba623` runs the verdict after the fixtures; on `66bd5bf` it covered all 12 of that run's |

The review recommended no change to the checkpoint representation, engine, profile or run schema, and none was made.

## Owner acceptance

The owner accepted M6B on 2026-10-10 (America/New_York).

| Identity | Commit |
| --- | --- |
| Accepted application code | `66bd5bf14e3458ea88a970a9741d2fa9087eec74` |
| Published remediation and evidence head | `4fbb1a65c77a67065c3a6196458debcc56f891df` |
| Accepted M6A base on `main` | `321d9e168026de780f6c5c98babaee190f956a13` |

- **The review and its remediation.** The owner accepted the independent review and its bounded remediation verification as sufficient for M6B, without a further re-review of `d6966fd..66bd5bf`. R1 (`72957b6`), R2 (`66bd5bf`) and R3 (`caba623`, this record) are closed.
- **Evidence carried forward, a bounded owner exception.** The M6A (`m6a-legible`, `m6a-record`, `m6a-guard`, `m6a-pace`), M1–M5 and P0–P2 native results ran on `d6966fd`, not on `66bd5bf`, and this record keeps them labeled that way. The owner accepted carrying them forward to `66bd5bf` because:
  1. the application changes are confined to pending-seek Play handling and the replay coordinator's pending-seek advancement guard;
  2. those native scenarios do not exercise pending seeking;
  3. M6B's affected native seek scenarios, `m6b-seek` and `m6b-long`, were re-run on `66bd5bf`;
  4. the automated regression tests were re-run on `66bd5bf`;
  5. the engine, checkpoint format, run record, field kernel and the accepted M6A linear oracle are unchanged.

  The exception covers these results for M6B only. It is not a general relaxation: a later milestone's native results still count only on the build they ran on.
- **Threads kept open.** Space with the timeline focused is unverified on a real keyboard and is not marked PASS (finding 10; M8's keyboard criterion). The deferred Play's status line moves the replay controls by 17 CSS px (finding 8; M8's playback states). Scrubbing feel on a real trackpad stays an optional owner check (finding 1). Each is listed below.

## Owner checks

Open after acceptance. None blocks M7.

- **Space with the timeline focused, on a real keyboard** (finding 10; unverified, carried to M8's keyboard criterion). Steps:
  1. Open `Lawsmith.app` (packaged `66bd5bf`).
  2. Open `scripts/verify/scenes/p1-workshop.lawsmith.json`.
  3. Record until the 60 s limit stops it, then press **Replay recording**.
  4. Click the timeline near its end, then press Space twice while it says "Seeking…".
  5. Expect "Then playing." after the first press and not after the second, with the replay still at tick 0 and nothing moving.
  6. After the seek ends, expect it paused at the target.
- **The status line under a deferred Play** (finding 8; assigned to M8's playback states, as interface polish, unless new evidence shows a correctness failure). Whether the cluster's buttons may move when " Then playing." appears, or the status should keep one line.
- **Scrubbing on a real trackpad** (finding 1; optional feel check). Steps:
  1. Open `Lawsmith.app` (packaged `66bd5bf`).
  2. Open `scripts/verify/scenes/p1-workshop.lawsmith.json`.
  3. Press **Record from tick 0** and **Play**, and drag a law now and then until the recording stops itself at 60 s.
  4. Press **Replay recording**, and drag the timeline across once quickly and once slowly.
  5. Judge whether the replay keeps up well enough, and whether the labels say where it is ("tick … of …", "Seeking to tick …").
  6. Press **Cancel seek** during a long first seek, then press Return to authoring.
- **The playback controls** (M6A's optional inspection, carried), now with the timeline and Cancel seek.
- Carried: M4's moving-body trackpad check and M5's Storm Bottle trackpad feel.

## Evidence provenance

- **The repaired candidate's M6B runs.**
  - **The build.** The packaged app was built at 20:47:53–20:48:08 on 2026-10-09 from `caba623`, whose application code is `66bd5bf`. Both counted runs started after it, and each app log holds one `qualification` event naming that bundle, `index-D25RU-Ve.js sha256:3dd2f808…`. The commits after `66bd5bf` change only `scripts/verify/` and `docs/`. After the last run, a rebuild from HEAD (`0a3ac0d`) reproduced the four hashes in the Environment table byte for byte, with the fault strings absent from `dist/assets`.
  - **The hands-off windows.** The owner agreed them ("you drive, I step away") for the re-run, and again for each of the two later `m6b-long` attempts.
  - **The counted runs.** `m6b-seek` 23:21:27–23:25:15 (the harness at `caba623`). `m6b-long` 23:40:02–23:44:44 (the harness at `0a3ac0d`). No click was lost in `m6b-seek`; one synthetic release was resent in `m6b-long`, and its log then showed it arrive. During `m6b-seek` another application came to the front once, and the harness brought Lawsmith back before its next input.
  - **Discarded attempts** (not cited; logs not published). In each, the app's log shows it behaving as specified.
    - **Re-run 1**, 23:12:59–23:14:23: the machine was saturated (finding 9), and `m6b-seek` stopped before any seek. With the owner's agreement the orphaned recorders were stopped, and the next attempt waited for the other build to end.
    - **Re-run 2's `m6b-long`** (its `m6b-seek` is the counted one): the presses sat in the Cancel segment, whose seek, from the checkpoint at (2160, 48), committed 4.02 s after its request, before the Space press. At the recorded end, Space correctly does nothing (`c47857d`).
    - **Re-run 3**: a `cliclick` `kp:space` logged no toggle (finding 10; `0a3ac0d`).
  - **Recordings.** Both counted runs recorded the screen. The recordings were not reviewed frame by frame for personal content, so they were not published; `m6b/m6b-seek.mp4` and `m6b/m6b-long.mp4` remain the `d6966fd` runs'.
  - **Personal identifiers.** The published logs and the eleven captures were checked for credentials, personal paths, user, account and host names, and none appear. So was the crop `m6b/review-then-playing.png`, a part of a discarded attempt's window capture.
  - **State the QA touched, restored.** The display read 1168×755@120 before and after. Lawsmith's panel preferences were re-imported from their pre-QA export, again leaving only `NSNavPanelExpandedSizeForOpenMode`. No QA disk image was attached, and no test instance was left running.
- **The reviewed build's runs** (`d6966fd`; M6A carried, M1–M5, P0–P2, and the first M6B runs, whose figures the review audited at `c119e3f`). The packaged app was built at 23:16:39–23:17:05 on 2026-10-08 from `1b57e47`, whose application code is `d6966fd`. Every counted run started after it, and every counted app log opens with a `qualification` event naming that bundle, `index-BiDBAne9.js sha256:a0c4f337…`. After the last run, a rebuild from `2151aa9` reproduced its four hashes byte for byte.
- **The reviewed build's hands-off window.** The owner agreed it ("you drive, I step away") at about 02:44 on 2026-10-09 and confirmed "continue I am off the keyboard now" at 03:04. The counted runs:
  - chain 4 (the harness at `456f938`, each scenario in a new QA folder of its own):
    - `m6b-seek` 03:04:49–03:08:24;
    - `m6a-legible`, `m6a-record`, `m6a-guard` and `m6a-pace` 03:08:25–03:19:57;
    - `m5-compose` through `m2-guard` 03:19:57–04:13:30.
  - chain 9 (the harness at `2151aa9`): `m6b-long` 04:32:22–04:36:53.
- **Lost synthetic events.** The harness resent 14 lost synthetic releases once each, and the app's log then showed each one arrive (M0 finding 1's class): `m4-perf` 7, `m3-p1` 2, and one each in `m2-demo`, `m3-demo`, `m3-handles`, `m4-explain` and `m6a-pace`.
- **Logs.** The logs in `m6b/native/` are the counted runs': for each scenario, the app logs' `[lawsmith]` lines (`<scenario>--<log>.log`) and the harness's step log (`<scenario>-steps.log`). `m6b-seek` and `m6b-long` are the `66bd5bf` runs; `git show c119e3f:docs/evidence/m6b/native/…` holds the `d6966fd` runs' logs and captures, which the review audited. Every other scenario's logs are the `d6966fd` runs'.
- **Discarded attempts on the reviewed build** (not cited; logs not published). In order, before chain 4 and between chains 4 and 9:
  - **Rehearsal 1:** stopped before its first click by another session's screenshot interface (`screencaptureui`, a full-screen window at layer 24). The owner chose to have it quit.
  - **Chain 1:** `m6b-seek`'s wait read the last seek event, which after a commit is its `drawn` event (`1347d9b`).
  - **Chain 2:** `m6b-seek` required superseding on the lab scene, where cached seeks end between pointer moves (`456f938`).
  - **Chain 3:** Notification Center covered the screen for over 10 s before the first click.
  - **Chain 4's `m6b-long`:** a seek committed 248 ms before the harness's Return landed (`427e01d`).
  - **Chain 5:** the eased drag sent requests about 470 ms apart (`5db6cb8`).
  - **Chain 6:** clicks during short seeks arrived after each commit (finding 1; `536a72c`).
  - **Chain 7:** yielded to the owner's input (exit 4).
  - **Chain 8:** the superseding click came after a 1.7 s seek committed (`2151aa9`).
  - In every case the app's log shows it behaving as specified.
- **Recordings and captures.** Captures are window captures (`screencapture -l`), which show only Lawsmith's window. Recordings capture the window's screen rectangle, so each was reviewed at one frame per second.
  - `m6b-seek.mp4` drops its first 2 s, where a notification banner from another application, with personal content, crossed the window.
  - `m6b-long.mp4` keeps its replay section, the first 38 s of 100; the rest showed the authoring view idle.
  - Neither shows an Open or Save panel.
  - Screen recording was off for P0, P1, P2, `m6a-pace` and both Shift+C runs.
- **Personal identifiers.** Logs, captures and videos were checked for credentials, personal paths, user, account and host names before publishing, and none appear.
- **State the QA touched, restored.**
  - Recovery directories were per run (`LAWSMITH_RECOVERY_DIR`) under a disposable folder, and scenes and run files lived in disposable folders.
  - `m2-files`' 1 MiB disk image was detached right after it.
  - The display read 1168×755@120 before QA and at the end.
  - Lawsmith's panel preferences domain held one key before QA (`NSNavPanelExpandedSizeForOpenMode`). The domain was re-imported from its pre-QA export afterwards, leaving that key alone.
  - No test instance or holder of the shared GUI lock was left running.

## Scope confirmation

M6B adds complete checkpoint capture and restoration, the keyed bounded cache, nearest-checkpoint selection and eviction, `RestoredReplay`, the latest-wins seek with its batches, progress and cancellation, the replay timeline, corrupt-cache reconstruction from the root, and the M6B fixtures and scenarios.

It changes none of the following:

- M6A's recording, run file, linear replay or the oracle's test;
- any engine, profile or dependency.

It adds none of the following:

- checkpoint-only replay or reverse integration;
- branching, a baseline, ghosts or alternates;
- portable checkpoints, cache persistence or cross-runtime snapshots;
- a cloud archive.

**M7 NOT STARTED.**
