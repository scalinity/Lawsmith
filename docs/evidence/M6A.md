# M6A qualification record

**Status:** ACCEPTED by the owner on 2026-10-08, on the acceptance review and its remediation (Review), and merged to `main`. The accepted code is `2c79d2d`: every finding fixed, with two owner decisions after the review (the identity stays as it is, and a recording carries the names of laws it creates, run schema 2), and every headless check passing. By the owner's decision, two checks did not run before acceptance. The first is the native re-qualification of `2c79d2d`: one attempt was stopped by the guard before its first click, and the native results below are `6903cf4`'s. The second is the owner's inspection of the playback controls. The native re-run carries into M6B's first native window (Owner checks).
**Candidate:** branch `m6a`, application code at commit `2c79d2d` (the reviewed code `6903cf4` with the review's fixes and the owner's follow-up). Every native result below ran on the packaged app built from `6903cf4` at 14:29:12 on 2026-10-08 (Evidence provenance); none has run on `2c79d2d` yet. Base: `1796676f89cd8033252619b1540d88484c0209ce` (M5 accepted and merged, on `main`, unchanged throughout).
**Scope:** M6A only. **M6B NOT STARTED.**

**Record, then replay exactly from the root.** Start Recording rebuilds the live world from a frozen copy of the authored scene at (0, 0). From then on the recorder keeps every command the host actually consumes, refusing any that would not fit before it applies. A replay builds a second world from that frozen root and applies each recorded command once at its own boundary, stepping only between settled boundaries, and stops at the frozen final address. It restores no snapshot and selects no checkpoint. In the packaged app a real intervention was recorded: a 25-sample drag while the stream played, a law disabled and enabled, a triangle gain given to a compound law's swirl and undone, and two paused edits at the final tick. It was stopped at (3298, 32) and saved, and the app quit. A fresh launch opened the file and replayed it under visualization the recording never had, and through a Hide. It reached (3298, 32) with the recorded state digest `055d2c6c…` and engine digest `d87d3aa0…`, and all 13 live checkpoints were equal. The retained authoring world was identical before and after its replay.

## Environment

| Item | Value |
| --- | --- |
| Machine | Apple M5 Pro, 48 GiB, arm64; built-in display at its Larger Text scale (1168×755 pt, 120 Hz), switched to 1728×1117 pt only for `m6a-legible`, `m6a-pace`, `m4-perf`, `m3-p1` and `m5-legible`, each restoring it. Normal power mode, on AC |
| macOS | 27.2, build 26B5091g, read by the app from `SystemVersion.plist` |
| WKWebView / WebKit | `22625.2.5.11.1` from `AppHandle::webview_version()`; origin `tauri://localhost`, secure context; backend WebGPU |
| Toolchain | Node 26.10.0, npm 12.2.0, rustc/cargo 1.99.0 (`rust-toolchain.toml`) |
| Tauri family, frontend packages | Unchanged from M5: `git diff 1796676..6903cf4` touches no `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` or toolchain pin. The app now reports the locked family itself: `tauri 3.0.0-alpha.4; tauri-runtime 3.0.0-alpha.3; tauri-runtime-wry 3.0.0-alpha.4; wry 0.57.0; tao 0.37.1` |
| Simulation profile, kernel | Profile `lawsmith-m1-rapier-0.21.0` and kernel `affine-ak-v2`, both unchanged (effective `dt 0.008333333767950535` and the other pinned values checked on every world) |
| Bundle (candidate `6903cf4`, built 2026-10-08 14:29:12; every counted native run) | `Lawsmith.app`, 13.51 MiB; `dist/assets/index-_JsT4sJa.js` SHA-256 `4414b3375cbbf6aeb3eecf052045d3d0943018c0bfc34ad0fafdaf17e1e1e9c6`; `index-C1BU_RcZ.css` `d8d11549ba23057ef1059ceb3a7fcc3f44ad36a0f3f29dc9afaa517fa8608db5`; `index.html` `48e9003f873e24514aaa34af1834d1de13660fc9faa2cb05b3a4e028c1895445`; shell binary `Contents/MacOS/lawsmith` `e2a06deceda72c01077a37ad75d77dd161114ffee47345258c9c8c614cd2d89e`. The packaged app's own identity reports the bundle as `index-_JsT4sJa.js sha256:4414b337…`, the same bytes |
| Superseded builds (rehearsals only, never cited as results) | `967f560` (before the pre-native review) and `fd4cab8` (before the layout fix; finding 3) |

## Commands and outcomes (candidate)

| Command | Outcome |
| --- | --- |
| `npm ci` | exit 0; `fsevents` install scripts blocked, as expected |
| `npm run typecheck` | exit 0 |
| `npx vitest run` | 27 files passed, 2 opt-in measurement files skipped: **578 tests passed, 2 skipped**. M5's 508, unchanged except that two test gestures now carry their transaction ID, plus 70 new: `recording` 18, `runFile` 16, `contexts` 9, `recordingLimits` 7, `workflow` 20 |
| `(cd src-tauri && cargo test)` | **27 tests passed**: M5's 24, plus token kinds, run names and the 16 MiB read bound |
| `(cd src-tauri && cargo check)` | exit 0 |
| `npm run build` | exit 0; the chunk-size warning of M1–M5. Rebuilt after the package, `dist` reproduced the three bundle hashes above byte for byte |
| `npx tauri build --bundles app` | exit 0; `Lawsmith.app`, 13.51 MiB |
| Fault-injection strings (`rapier-hang`, `LAWSMITH_FAULT`) in `dist/assets` | absent |
| `git diff --check 1796676..HEAD` | exit 0 |
| `VITE_LAWSMITH_MEASURE=1 npx vitest run tests/recordingCost.test.ts --silent=false` | exit 0; `m6a/recording-cost-headless.log` (Performance) |
| Native scenarios (packaged `6903cf4`) | M6A: `m6a-legible` 7 checks, `m6a-record` 35, `m6a-guard` 17, `m6a-pace` 3. M1–M5 regression on the same build: `m5-compose` 37, `m5-legible` 3, `m4-trails` 6, `m4-perf` 13 (P0, P2), `m3-p1` 6 (P1), `m4-explain` 28, `m3-handles` 43, `m3-demo` 26, `m2-demo` 14, `m2-authoring` 20, `m2-files` 19, `m2-guard` 36. Every counted run exited 0 with no failed check (Evidence provenance) |

## Implementation

| Module | Holds |
| --- | --- |
| `src/simulation/host.ts` | `setAmbient` joins the command vocabulary; commands carry a `transactionId` from submission to acknowledgment; `AppliedCommand`; the `CommandRecorder` hook: `admit` before a command mutates anything, `append` after, `stepped` after each transition; `halted` (a limit closed the record: nothing is consumed or stepped until the owner discards the queue and calls `releaseHalt`); `applyRecorded` (replay: the same `apply` with the recorded sequence, no acknowledgment); `futureState()` (the canonical state plus the live settings); live settings (`settings` returns the root's with the current ambient); `worldCounts`/`resetPeakWorlds`; `reset` refuses while a recording is attached. `canonicalState()` is unchanged, so the accepted oracle digests are too |
| `src/domain/document.ts` | `newTransaction()` (`tx-<n>`, session-wide); discrete edits (field edits, create, duplicate, delete, undo, redo) settle at the current boundary before returning and keep their undo entry and presentation only once the host applied them (`NOT_APPLIED` otherwise); gesture samples still queue and coalesce; `endGesture()` (a gesture's one undo entry, from its start to the state the host applied); `discardPending()` and `unchangedSince()` (revisions a limit discarded unapplied change nothing); `setAmbient()` (no control offers it); `reset(root?)`; `liveHost` |
| `src/persistence/runFile.ts` (new) | The RunRecord types, `RUN_LIMITS`, compact canonical command text, the exact file layout and its size arithmetic (`runBytes`, `reservedEnvelopeBytes`), `serializeRun`, `utf8Bytes`, `createdLawIds` and `createdLawReserve` (the laws a recording creates and keeps, and the widest entry each reserves), `qualificationIdentity`, `qualified`, and `parseRun`, the strict transactional reader |
| `src/simulation/recorder.ts` (new) | `SIMULATION_FINGERPRINT` (profile, Rapier version and WASM SHA-256, effective parameters, field kernel, command semantics, step); `RunRecorder` (preflight, append, duration close, synchronous capture of the final address); `RunRecorder.check` (refuses a root too large to record before anything is rebuilt); `exportRun` |
| `src/simulation/replay.ts` (new) | `LinearReplay`, the checkpoint-free oracle: a new world from the frozen root, `settle`, `step`, `advance`, `runTo(address)`, `runToEnd`; `observe` and `firstDivergence` (address, laws, settings, emitters, bodies by stable ID, then engine bytes) |
| `src/simulation/contexts.ts` (new) | `RunCoordinator`: the authoring context, the recorder, the finalized record and whether it was exported, the replay context, the selection, an import's candidate and the counts; `startRecording`, `stopRecording`, `resolveStop`, `settled`, `enterReplay`, `restartReplay`, `returnToAuthoring`, `advanceReplay` (budgeted units with a step observer), `checkReplay`, `prepareImport`/`discardImport`/`commitImport`, `dropRecord`, `counts` |
| `src/persistence/workflow.ts` | Save Recording, Open Recording (transactional, rereading after a guard save), Start Recording through the guard; the guard asks about two artifacts by name, the selected context's first, and stages every Discard until the transition commits |
| `src/persistence/io.ts`, `src-tauri/src/main.rs`, `src-tauri/src/document_io.rs`, `src-tauri/build.rs` | `open_run`, `read_run`, `choose_run_destination`, `write_run` (16 MiB), `ask_unsaved_recording`; dialog tokens carry their kind (scene or run); `runtime_identity` adds the app version, macOS product and build from `SystemVersion.plist`, and the locked tauri-runtime, tauri-runtime-wry, WRY and TAO versions that `build.rs` reads from `Cargo.lock` |
| `src/rendering/worldView.ts` | `prepareScene(root, own)` and `swapScene`: a replay keeps its own static view while the authoring one waits; body materials are released with their meshes |
| `src/main.ts`, `index.html`, `src/style.css` | The qualification identity (bundle SHA-256 read back from the packaged asset); the coordinator; the displayed world (`host`) versus the authoring world; read-only replay; context switches with view and camera handover; the replay driver; the limit handler; `run-checkpoint`, `recording`, `context`, `context-live`, `replay-complete` and `m6a-fixtures` events; the recording controls (`#run`) |
| `tests/` | `recording` 18, `recordingLimits` 7, `runFile` 16, `contexts` 9, `workflow` +20, `recordingCost` (opt-in); `tests/support/run.ts` (the laboratory scene, a session, a drag as LawInteraction makes it) |
| `scripts/verify/` | `m6a-record`, `m6a-guard`, `m6a-legible`, `m6a-pace`, `m6aq.py`, `ax.js buttons`, `lib.zsh alert_for`, `scenes/m6a-lab.lawsmith.json` |

No dependency was added or changed, and the scene schema stays 1. The recording format is new: `lawsmith.run`, schema 2. Schema 1, which had no `createdLaws`, is the format of `6903cf4`'s saved run (`m6a/m6a-qa.lawsmith-run.json`).

## The RunRecord (SPEC §13.3)

A `.lawsmith-run.json` file is canonical JSON, keys sorted, with the log first and one compact command per line:

```text
{
  "commands": [
    {"atTick":741,"payload":{"field":{…"id":"push","pose":{"position":[-1.7131109080900822,1,0],…}},"kind":"putField"},"sequence":1,"transactionId":"tx-1"},
    …
  ],
  "finalCheck": {"engineSha256": "…", "stateSha256": "…"},
  "finalTick": 3298,
  "format": "lawsmith.run",
  "lastAppliedSequence": 32,
  "qualification": {"app", "arch", "build", "bundle", "os", "tauri", "webkit"},
  "root": { the frozen tick-zero scene document: format, schema, capabilities, semantic, law presentation, title },
  "runId": "run-<uuid>",
  "schemaVersion": 1,
  "simulationFingerprint": {"commands", "effective", "fieldKernel", "profile", "rapier", "rapierWasmSha256", "step"},
  "stopped": "user" | "duration" | "commands" | "bytes" | "fault"
}
```

| Field | Meaning |
| --- | --- |
| `root` | The authored scene at Start Recording, deep-copied and frozen: the semantic block (bodies, emitters, every law, settings), the law names and colors, the title. No camera. It never aliases the editable scene |
| `commands` | Each consumed command: `atTick` (applied after that many completed steps, before the next), `sequence` (1, 2, 3, … with no gaps), `transactionId` (the user action it belonged to) and the resolved payload: `putField` (the complete validated law), `removeField` or `setAmbient` |
| `finalTick`, `lastAppliedSequence` | The frozen final address: the cursor is the last included sequence, 0 for an empty log |
| `finalCheck` | SHA-256 of `futureState()` and of the engine snapshot, captured at the final address when the recorder closed; absent only for a run ended by a fault, whose world no longer holds that state |
| `simulationFingerprint` | `profile lawsmith-m1-rapier-0.21.0`, `rapier 0.21.0`, `rapierWasmSha256 17cfa80e…dd4b` (the embedded module, re-derived from the installed package by a test), the eight effective engine parameters, `fieldKernel affine-ak-v2`, the command semantics, `step 1/120` |
| `qualification` | `app Lawsmith 0.0.0`, `build packaged`, `bundle index-_JsT4sJa.js sha256:4414b337…`, `tauri` (the locked family above), `webkit 22625.2.5.11.1`, `os macOS 27.2 (26B5091g)`, `arch aarch64` |

**setAmbient.** SPEC §10.2's vocabulary includes it, and M5's host had only put and remove. It is now a host command applied at its boundary, adopted into the authored scene's settings, recorded, replayed and validated on import (finite, at most 200 m/s²). No control offers it, and no settings editor was added; tests drive it through the document. `futureState()` carries the live settings, so a replay compares it.

**Qualification without self-reference.** Nothing is embedded in the bundle: the packaged frontend fetches its own module from the app's asset origin and hashes the bytes it is running. Rebuilding from the same inputs gives the same name and hash, as the rebuild above shows. The macOS product and build come from the system's record, the Tauri family from `Cargo.lock` through `build.rs`, and the WebKit version from `webview_version()`. A fact the app cannot read is recorded as `unavailable: …`, and then the identity is not qualified. In a development build the bundle is `unbundled: development server` and `build` is `dev`, and the replay says it is not a qualified exact replay.

## Recording (SPEC §10.2, §13.3; AC2)

**Where commands are consumed.** Every authoritative path settles through one method, `SimulationHost.settleBoundary()`. That covers the frame loop, `DocumentController.settle()` (edits, undo, redo, create, duplicate, delete, reset, the save and recovery snapshots, digests) and `host.step()`. So the preflight lives there. For each queued command it resolves the address `(tick, lastAppliedSequence + 1)` and checks that a removal names a law. It then asks the recorder to `admit` the command before anything changes. A refusal halts the host with that command and everything after it still queued. Accepted commands are applied, appended and acknowledged. The document adopts acknowledgments as before, so recording and adoption watch the same consumption, separately.

**Consumed, not submitted.** Pointer samples still coalesce per law until a boundary consumes them, so the log holds one command per boundary a drag reached, never the input events. `tests/recording.test.ts` F: ten samples before one boundary and seven before the next record two commands, the 10th and the 7th. Natively, `m6a-record`'s drag committed 25 samples, and the record holds 25 commands of transaction `tx-1` on 25 distinct boundaries (ticks 741 … 1407).

**Transactions.** `DocumentController.newTransaction()` issues `tx-<n>`, never reused in a session. A gesture takes one at its beginning, and every sample and a cancel's restore carry it. Each discrete edit takes its own. An undo or redo is a new action with a new transaction, so it never removes or rewrites earlier commands (`recording.test.ts` E: four drag samples, then an undo and a redo as two later commands of two other transactions). The undo entry carries the gesture's transaction, so the two can be matched.

**Undo entries only for applied commands.** Discrete edits (field edits, create, duplicate, delete, undo, redo) now settle at the current boundary before returning. They keep their undo entry and presentation only once the host has applied them. A command refused at a limit therefore leaves no undo entry for a change that did not happen. This changes no simulation: the command lands at the same boundary n either way, since the next frame would have settled it before stepping. M5's suites are unchanged and pass.

**The frozen root.** `startRecording` settles, then deep-copies and freezes the authored scene (`cloneFrozen`) and checks the reserved envelope fits, before anything changes. Only then does it rebuild the live world from that copy and attach the recorder at (0, 0). A host refuses `reset` while a recorder is attached. `recording.test.ts`: the root equals the authored scene and is a different object at every level. Everything reachable from the record is frozen. After the stop, a primitive edit, a triangle gain, a mask change, an added ingredient, a disable, a removal, undo, redo, a reset, a created law and a scene load leave the root's and every command's canonical text byte-identical.

## Replay (SPEC §13.2–13.4; AC1, AC3, AC4)

`LinearReplay` is the checkpoint-free oracle M6B will compare against. It builds a new world from `cloneFrozen(record.root.semantic)` at (0, 0), and `applyRecorded` uses the host's own `apply`, the single interpretation of a command. A unit settles the current boundary's recorded commands if any remain. Otherwise it steps once and settles the next boundary. It never steps from an unsettled boundary or past `finalTick`. `runTo(address)` stops at any address on the record's path, between same-tick commands included. It refuses an address behind it, beyond the end or off the path. `observe` and `firstDivergence` compare, in order: the address, then laws, settings, emitters (PRNG state, ordinal) and bodies (identity, death tick, pose, velocities) by stable ID, then the engine bytes. They name the first difference's tick, cursor, entity, component and both values. Nothing in production replay restores a snapshot or chooses a checkpoint: `restoreSnapshot` appears nowhere in `src`, and `engineSnapshot()` only observes.

| Fixture (`tests/recording.test.ts`, real host, document, recorder and coordinator) | Result |
| --- | --- |
| T09 primary: a 12-boundary drag with four coalesced samples, an enable change, a triangle gain on the Storm Bottle's swirl, live undo, a paused three-sample drag at one tick, two paused terminal edits | the record holds the 12 drag samples on 12 boundaries in one transaction (15 submitted), the paused drag's 3 at one tick, the undo as a later command of another transaction with the triangle still before it; replay equal at all 223 settled boundaries (every tick, (0, 0) included) and, through the oracle, at every address the live run passed through, same-tick cursors included; `checkReplay` matches |
| The file carries everything | serialize → read → serialize byte-identical; the read record replays to the live final state |
| A: two paused edits at one tick | sequences 1 and 2 at tick 30; the oracle stops at (30, 1) and then (30, 2), each equal to the live state |
| B: final-tick commands | ends at (50, 2) with no step past 50; one command short is a different address (the cursor diverges) |
| C: zero duration | three tick-zero commands: one unit, zero steps, the final state exact; the file reads back |
| D: post-stop edit | a third edit at the same tick, made before the record even finished finalizing, changes the live scene and not the record; later steps, a reset and edits leave its text byte-identical |
| E: undo | a later command; the four consumed samples stay |
| F: coalescing | only consumed samples recorded |
| G: a 400-command batch at one boundary | applied in 64-command chunks with a yield after each; never past tick 12 while partial, reported partial, order kept, final state exact |
| Untouched root laws | at (0, 0) the replay holds every root law (`calm`, `push`, `storm-bottle`) exactly; newer authored values never appear; after the replay the edited law has its recorded value and the others their root values |
| A retuned triangle | equal tick for tick; 120 paused frames at three ticks change nothing |
| `setAmbient` | recorded, adopted, replayed exactly; the root keeps the old gravity |
| Negative controls | one drag sample one ulp off: first divergence at that command's tick and cursor, `law push`, `pose.position.0`, −0.9 vs −0.9 + ε. A log keeping only the drag's last transform: diverges at the first lost sample's tick (`address.cursor` 1 vs 0). An untouched root law one ulp off: at (0, 0), `law calm`, `expression.coefficient`. One step too many: `address.tick` |

## Recording limits (SPEC §13.3; AC7)

**The budget is the complete file.** The file's size follows from its parts: the envelope (everything but the log) plus, for n > 0 commands, the sum of their compact texts + 6n + 4 (`[]` for none). The recorder holds the envelope at its largest endpoint from the start: final tick 7200, cursor 50000, a final check present, the longest stop reason. Advancing time or stopping can therefore never grow the file past what it has admitted. Each command's UTF-8 length is counted from its text, never from `.length`. `tests/runFile.test.ts` checks that arithmetic against real serialization, for titles in ASCII and in `Sturmflasche — 嵐の瓶 🌪️`. `utf8Bytes` matches an encoder for two-, three- and four-byte characters and lone surrogates. A root whose envelope could not fit is refused before the live world is touched. Natively the recorder reserved 18,023 bytes and the exact export was 18,016. The 7-byte difference is the reservation: three digits fewer in cursor 32 than in 50000, and four characters fewer in `user` than in `duration`.

| Limit (`tests/recordingLimits.test.ts`) | Result |
| --- | --- |
| Duration | unrecorded authoring runs to tick 7300; recording closes exactly at 7200 (`duration`), the world held there; a queued edit and further steps are refused until the stop resolves, then discarded; the live world then continues, unrecorded, to 7210; the record replays to 7200 and reads back |
| Natively (`m6a-pace` rehearsal on `fd4cab8`) | a P1 recording that ran past 60 s closed itself at exactly tick 7200 with 145 commands, `stopped: duration` |
| Count | the 50,000th command (an ordinary edit with its undo entry) is recorded; the 50,001st is refused before it changes anything (`NOT_APPLIED`), with no undo entry; undo then undoes the 50,000th; the refused edit can be made again unrecorded; the capped file reads back and replays to the same state |
| Bytes | compound 64-node puts, then ambient commands, then the last few padded through their transaction IDs, fill the reserved total to exactly 16,777,216 bytes, accepted; the next command, however small, is refused before it applies; the saved file is within the limit (16 bytes under: the reservation) and reads back |
| Import | a file of exactly 16,777,216 bytes is read; one byte more is refused; a multibyte title whose character count is under the limit but whose UTF-8 is over it is refused |
| Count limit halfway through a live drag | the consumed samples kept in order, one per boundary; the refused sample not applied and its step not taken; nothing queued survives; the gesture ends at the last applied value, so its one undo entry goes back to the start and redo to that value; the record replays to its accepted prefix and checks itself; it reads back |
| Byte limit halfway through a live drag | the same |
| `settled()` right after a limit, before the scheduled resolution | returns the closed record (finding 1) |

**At a limit** the recorder freezes its prefix and captures the final state at once. The host stays halted, consuming and stepping nothing, until `resolveStop` discards the queued commands and releases it. The app then pauses, ends any gesture at the value the host last applied (`release(reason, settled)`), drops the discarded revisions from its edit accounting and says which limit stopped the recording.

## Contexts and the retained authoring world (SPEC §13.2; AC5, AC10)

`RunCoordinator` is the one owner. It holds the authoring context (the controller and its live world), the recorder, the finalized record and whether it was exported, the replay context, which context is selected, and an import's candidate. Only the selected world advances, and the frame loop drives either the live world or the replay, never both. Every switch pauses, discards scheduling debt, clears the explained body and the ingredient focus, and re-syncs probes and trails to the new world's generation. It also restores that world's fault message, if it has one. Replay is read-only. Every authoring command is refused there: edits, the shelf, undo and redo, delete, presentation, Arrows, Save Scene. The details and the shelf are inert, the gizmo is hidden and disabled, and handles are not drawn. Playback, camera and visualization controls still work. The replay shows its root's law names, colors and arrow default, and its own static view. The authoring view and camera are kept aside and come back on Return.

| Check (`tests/contexts.test.ts`) | Result |
| --- | --- |
| Return to authoring | after 25 replay units, a restart and a run to the end: the same host object, generation, observed state and engine bytes, scene object, revision, applied revision, document generation and undo/redo availability; no acknowledgment reached the document; then 90 steps, an undo and 30 steps equal a twin session that never replayed |
| Only the selected context advances | 100 replay units: the live tick unchanged |
| The frozen end | paused at (73, cursor); 30 more frames change nothing; the end check matches |
| Probes observing the replay | through the step observer, 600 probes evolve bit for bit as the live ones did through recorded edits; observed after the unit instead (the pre-review ordering), they drift (Review, R4) |
| Presentation | 2,000 probes, 32 trails, a changing explained body and previews leave every replayed boundary exact; 30, 60 and 144 Hz pacing reach the identical end |
| Stale views (M4's gate) | trails clear on entering replay and on Return, before any step, and never carry another world's bodies |
| T11 | 20 replay/return cycles: 1, 1 and 0 extra worlds (entered, restarted, returned) every cycle, peak 1; 20 restarts: 1; 20 imports from replay (valid, discarded, invalid, unbuildable): 2 worlds with the candidate, 1 after, peak 2 extra (3 with authoring); a candidate that cannot be built allocates nothing; back to the base count on Return |

## Native files and guards (SPEC §15; AC6, AC9)

The run file uses M2's native path: native dialogs (`Open Recording`, `Save Recording`) and bounded strict UTF-8 reads within 16 MiB. Replacement goes through a sibling temporary file, serialized with the scene writes. Dialog tokens now carry their kind, so a scene token can never write a recording, or the reverse. A name without `.lawsmith-run.json` is refused, never renamed, and `x.lawsmith-run.json` does not pass as a scene name. Save Recording writes the record and nothing else. It exports exactly, refusing a file over the limit before writing. An active recording is first stopped under its normal policy.

**Strict reading** (`tests/runFile.test.ts`): the format comes first, with the reverse hint (a scene says "open it with Open Scene", and the scene reader says the same of a recording). Then the schema, then the simulation fingerprint and the qualified identity, before anything else is read. Both are refused as incompatible, naming every difference. Then the root (through the scene reader, refusing a camera or a non-canonical form) and the endpoint (final tick within 0–7200, the cursor equal to the last sequence, the final check consistent with the stop reason). Then every command: exact keys, `__proto__` refused as unknown, sequences from 1 without gaps, boundaries never going back and never past the end, valid transaction IDs, payloads valid and in canonical form (a non-unit direction, a −w quaternion or `1e400` is refused), removals of laws that exist at that point, no IDs of bodies or emitters, at most 32 laws and 256 leaves throughout. A refusal returns no record.

**Transactional Open Recording** (`tests/workflow.test.ts`): one unstepped candidate world and its view, then the guard for an unsaved recording, then commit. Invalid, incompatible, scene-shaped and unbuildable files change nothing, from authoring or from replay: the selection, replay, record, export flag and world count all stay. If the guard saved onto the very file being opened, that file is read again.

**The guard protects two artifacts by name.** The scene's alert asks Save, Don't Save or Cancel. The recording's says "Do you want to save the recording of “…”?" with "It holds N recorded changes over T s. Recordings are not kept for recovery, so it is lost if you don't save it. Saving it does not save your scene." and offers Save Recording…, Don't Save or Cancel. The selected context's artifact is asked about first. A running recording is finalized first. Every Discard is staged until the whole transition commits. A Cancel, a canceled dialog or a failed save abandons the transition, and leaves the selected context paused and every artifact as it was; a completed save stays saved. Close, Quit, New Scene and Open Scene protect both artifacts. Open Recording and Start Recording protect only the recording, since the scene is not replaced. The native Dock Quit guard is told about an unsaved recording as well as an unsaved scene. Recovery remains the main scene's only.

| Case (`tests/workflow.test.ts`) | Result |
| --- | --- |
| Save main scene → Cancel recording | the scene saved, the recording kept unsaved, nothing closed |
| Staged Discard scene → Cancel recording | recovery exactly as it was; the recording kept |
| From replay: Save Recording → Cancel scene | the recording saved, the scene unsaved, the same replay at the same address |
| From replay: staged Discard recording → Cancel scene | the record, its replay and selection kept |
| A failed recording save; a failed scene save | the transition abandoned; nothing lost |
| Save main authored scene from replay | writes the retained authored document, never the replay root |
| A canceled Save As inside the guard | the same paused replay |
| Both saved, or both discarded | closes; a discarded scene retires recovery |
| A running recording at Quit; simultaneous requests | finalized first; the second request coalesces; an Open during the guard is refused |
| New and Open Scene | drop the recording only after its guard; an already saved one needs no question |
| Start Recording over an unsaved recording | asks first: Cancel keeps it, Discard starts afresh |
| Recovery while replaying | captures the retained authored document and no recording |

## In the packaged app: a real intervention, saved, relaunched and replayed (`m6a-record`; AC1, AC2, AC4–AC6, AC8)

Packaged `6903cf4`, the M6A lab scene (`scripts/verify/scenes/m6a-lab.lawsmith.json`: the Storm Bottle in the colliding stream beside an independent push and an untouched drag). Real gizmo drags, clicks and keys, the real Open and Save panels and a real quit and relaunch; `m6aq.py` compares the two sessions' logs with its own code.

| Step | Native result |
| --- | --- |
| Identity | `qualification` reported qualified: `build packaged`, `bundle index-_JsT4sJa.js sha256:4414b337…` (the built file's hash), the Tauri family, WebKit, macOS and arch above |
| Record from tick 0 | started at (0, 0); 6,015 bytes reserved |
| A drag of `push` while the stream played | one gesture of 25 samples; the record holds all 25 as transaction `tx-1` on 25 distinct boundaries, ticks 741–1407 |
| Storm Bottle disabled, then enabled | two commands |
| Paused: a gain, then a triangle, on the swirl | two commands at one tick (2549, sequences 28 and 29) |
| ⌘Z while playing | undid the triangle: a later command of its own transaction; the triangle (29) stays in the log |
| Two paused edits at the final tick, then Stop | the record froze at **(3298, 32)**, 32 commands, `stopped: user`, final check state `055d2c6c…`, engine `d87d3aa0…`; sequences 31 and 32 at 3298 |
| A third edit at the same tick, after the stop | applied to the live scene (cursor 33); the record's address stayed (3298, 32) |
| Replay recording | a second world from the root at (0, 0) (2 worlds); the replay's push is the root's (enabled, at −1.5), not the newer authored one (disabled); laws `calm`, `push`, `storm-bottle`; title "Replay of “M6A lab”", Replay from start and Return to authoring offered, Record not |
| Played to the end | (3298, 32) and `check: match`; at the end paused, read-only, "Reached the recorded end exactly: state and engine match." |
| ⌘S during the replay | refused (`file-control` `refused`, reason `replay`): nothing saved |
| Return to authoring | the replay world freed (1 world); the retained scene back with its disabled push; `m6aq retained`: the authoring world's state (`d0a5baa6…`) and engine (`d87d3aa0…`) digests, tick, cursor, revision 33, generation and undo availability identical before and after the replay; no catch-up ticks (still 3298) |
| Save Recording | `m6a-qa.lawsmith-run.json`, 18,016 bytes, through the native panel; `m6aq runfile` audits its structure independently (the drag transaction, both same-tick groups, the triangle and its undo, the disable commands, the terminal commands, the endpoint) |
| Quit | the guard asked about the scene (Don't Save); the saved recording needed no question |
| **Session B: a fresh launch** | Open Recording through the native panel: validated and committed in 9 ms (read 0.09, parse 4, candidate 2, commit 3), replaying from (0, 0) beside the default scene |
| Visualization session A never had | 2,000 probes, all 32 trails, one law's arrows, an explained body |
| Hide during playback (at tick 376) | paused on native focus loss; nothing advanced while hidden; still paused at the same tick after reactivation; Play explicit |
| Played to the end | **(3298, 32), `check: match`, state `055d2c6cdc184e1c2f7a35a09eb62573134d22267a30e943064003765fe5d677`, engine `d87d3aa0774b1f5a4b576b5ea06bc9f767becff39c3807fcee68e89cb1c4cc83`: the recording's final check** (`m6aq final`) |
| Checkpoints | every live `run-checkpoint` of session A has an equal replay checkpoint in session B, state and engine, at the same address: 13, at (240, 0), (480, 0), (720, 0), (960, 8), (1200, 16), (1440, 25), (1680, 25), (1920, 26), (2160, 26), (2400, 27), (2640, 29), (2880, 30), (3120, 30) (`m6aq checkpoints`) |
| Shift+M, in this runtime | the linear oracle run twice from the root over 3,298 units: no divergence, and its end equals the record's final check (1.7 s); T11 below |

As in M3–M5 this is an equality within one qualified runtime (SPEC §13.1). Session B did not inherit anything from session A but the file, so the record alone carried the experiment.

Recordings: [m6a-record.mp4](m6a/m6a-record.mp4) (session A, 102 s of 110), [m6a-replay.mp4](m6a/m6a-replay.mp4) (session B, 69 s of 80), each cut where something other than Lawsmith's window was on screen (Evidence provenance). Playback uses the recorded commands: session B's video shows no pointer on any law, only the replay applying them. Captures: [idle](m6a/record-01-idle.png), [recording](m6a/record-02-recording.png), [stopped](m6a/record-03-stopped.png), [the replay's root laws](m6a/replay-01-root.png), [the replay's end](m6a/replay-02-end.png), [returned](m6a/replay-03-returned.png), [the fresh launch's end](m6a/replay-04-fresh-end.png). The saved run is [m6a/m6a-qa.lawsmith-run.json](m6a/m6a-qa.lawsmith-run.json).

## Guards and imports in the packaged app (`m6a-guard`; AC6, AC9)

| Step | Native result |
| --- | --- |
| A recording, then a dirty scene; ⌘Q from authoring | the scene's alert first (Don't Save, staged), then the recording's (Cancel): Lawsmith stayed open, the recording kept unsaved, and the recovery snapshots still there: the staged Discard was not committed |
| From replay, ⌘W | the recording's alert first (Save Recording…, through the Save panel), then the scene's (Cancel): stayed open, the same paused replay at the same address, the recording now saved |
| From that replay: a malformed run | refused at `commands[1].sequence` |
| A run with another WebKit version | refused as incompatible at `qualification`, naming `webkit`; never replayed |
| A scene file | refused at `format`: "open it with Open Scene" |
| After each refusal | the same replay, run and address, and no candidate left |
| The saved run, from replay | opened with no question (it is saved): a fresh replay from (0, 0) |
| ⌘Q from replay | the scene's alert (Save): the file written holds the authored scene (calm disabled), not the replay's root (calm enabled) |
| Relaunch | no recovery offered: the save retired it |

Captures: [canceled](m6a/guard-01-canceled.png), [the replay kept](m6a/guard-02-replay-kept.png), [imports](m6a/guard-03-imports.png).

## T11 in the packaged app (Shift+M; AC10)

Through the same calls the controls make, in session B, with the render readback after each step:

| Phase | Worlds | Contexts | Geometries / textures / scene objects |
| --- | --- | --- | --- |
| Before | 1 | authoring | 38 / 5 / 119 |
| 20 replay/return cycles (each: enter, 30 units, Replay from start, 30 units, Return) | 1 after every cycle | authoring | 38 / 5 / 119 after every cycle |
| 20 restarts inside one replay | 2 throughout | authoring + replay | 41 / 5 / 135 throughout |
| 20 imports from replay (valid, invalid, canceled, unbuildable, five each) | 3 while a candidate exists (valid, canceled), 2 otherwise; 2 after each | candidates 1, then 0 | 41 after each |
| After Return | 1 | authoring | 38 / 5 / 119 |
| Peak during the imports | 3 | | |

No count grows. The candidate is the one transient extra world, unstepped (its address (0, 0)). Return frees the replay world, and the render resources return to the authoring view's own. A run that cannot be built allocates nothing. Shift+V afterwards reported one authoring world, no replay and no candidate. The bodies' instance material is now released with its mesh. The pre-native review found it was not (Review, R7). The counts above do not include materials, so that fix rests on reading the code.

## Recording controls (SPEC §11.1; AC9)

Top right, below the tools and over the scene's open sky. The bottom left belongs to the diagnostics overlay and the bottom right to the switches and the transport. The body readout starts below the cluster, whatever its height.

| State | What it shows |
| --- | --- |
| Authoring, no recording | Record from tick 0 (titled: "Resets the motion to tick 0, keeping your laws, and records every change you make…"), Open recording…; "Resets the motion to tick 0, then records what you change." |
| Recording | a coral dot, "Recording 21.24 s of 60 s, 29 changes" (the capture), a thin meter of the nearest limit, Stop recording |
| Recorded | "Recorded 27.48 s and 32 changes. Not saved yet." (or "Saved."; a limit adds "It stopped at the 60 s limit." and so on), Replay recording, Save recording…, Record from tick 0, Open recording… |
| Replay | a lavender serif title "Replay of “M6A lab”", "Read-only", "tick 3298 of 3298, change 32 of 32. At the recorded end." (the capture; while it runs "Playing." or "Paused.", and during a long same-boundary batch "Applying the recorded changes at tick n…"), a read-only meter, and at the end the check "Reached the recorded end exactly: state and engine match."; Replay from start, Return to authoring, Save recording…, Open recording… |

Reset Scene keeps its own meaning and is disabled in replay ("Reset restarts your authored scene. Return to authoring to use it."). Replay from start rebuilds the recording's root. Return to authoring brings the kept world back. Record from tick 0 starts a new experiment. No seek control is offered, and the meter cannot be dragged.

**1280×800** (`m6a-legible`, More Space): the content viewport read back 1280×800 CSS at DPR 2, with the Storm Bottle selected (support x 617–930, y 245–638). The cluster stayed inside the window. It was clear of the panel, tools, transport, switches, body readout, diagnostics overlay and the selected support in every state. Its rects (x, y, w, h): idle 913, 52, 355, 90; recording 1020, 52, 248, 98; recorded 828, 52, 440, 124; replay with the check 828, 52, 440, 154. Nothing scrolled sideways. At the **900×600** minimum window it is clear of every UI region too. There its replay state (y 52–206) meets the top of the Storm Bottle's projected support (from y 184) in this scene's framing, which is reported, not gated (finding 4). Captures: [idle](m6a/m6a-1280x800-idle.png), [recording](m6a/m6a-1280x800-recording.png), [the replay's end](m6a/m6a-1280x800-replay-end.png), [900×600](m6a/m6a-900x600-replay-end.png).

## Performance (AC7, performance gate)

**P0, P1, P2 on the candidate** (packaged `6903cf4`; SPEC §18.2 protocol, unchanged from M2–M5: a focused window, a 1600×1000 CSS viewport at DPR 2 rendered under the 1.5 cap, recording off, 10 s warmup, 60 s measured, three runs, real drags about every 1.5 s feeding edit latency). Percentiles p50 / p95 / p99 / max in ms; runs are never averaged:

| Workload | Run | Step | Edit → frame (n) | Frame interval | Frame work | Sim/wall |
| --- | --- | --- | --- | --- | --- | --- |
| P0, the recipe, 64 bodies, 125 arrows | 1 | 0 / 1 / 1 / 1 | 6 / 16 / 17 / 17 (145) | 17 / 18 / 18 / 18 | 1 / 2 / 3 / 5 | 1.000 |
| | 2 | 0 / 1 / 1 / 1 | 6 / 16 / 17 / 17 (145) | 17 / 18 / 18 / 23 | 1 / 2 / 3 / 3 | 1.000 |
| | 3 | 0 / 1 / 1 / 1 | 6 / 15 / 16 / 16 (145) | 17 / 17 / 18 / 19 | 1 / 2 / 3 / 4 | 1.000 |
| P1, 200 colliding bodies, 16 one-leaf laws, 16 fixed colliders | 1 | 1 / 2 / 2 / 3 | 8 / 17 / 18 / 18 (146) | 17 / 17 / 18 / 25 | 3 / 4 / 5 / 7 | 1.000 |
| | 2 | 1 / 2 / 2 / 3 | 8 / 17 / 18 / 18 (144) | 17 / 17 / 18 / 19 | 3 / 4 / 5 / 6 | 1.000 |
| | 3 | 1 / 2 / 2 / 4 | 7 / 17 / 19 / 32 (144) | 17 / 17 / 18 / 133 | 3 / 5 / 6 / 13 | 0.999 |
| P2, 100 bodies, 2,000 probes, 32 trails, 24 arrows | 1 | 0 / 1 / 1 / 1 | 9 / 18 / 20 / 20 (146) | 17 / 17 / 18 / 19 | 4 / 6 / 6 / 8 | 1.000 |
| | 2 | 0 / 1 / 1 / 1 | 10 / 18 / 19 / 21 (148) | 17 / 18 / 18 / 20 | 3 / 5 / 6 / 9 | 1.000 |
| | 3 | 0 / 1 / 1 / 2 | 10 / 18 / 18 / 19 (148) | 17 / 17 / 18 / 19 | 4 / 5 / 6 / 7 | 1.000 |

Every run is valid and meets its gates. P0: step p95 ≤ 2 and p99 ≤ 4 ms, work p95 ≤ 12 ms. P1 and P2: step p95 ≤ 3 and p99 ≤ 5 ms, work p95 ≤ 14 ms. All: interval p95 ≤ 20 and p99 ≤ 34 ms, edit p95 ≤ 50 ms, sim/wall ≥ 0.98. The limiter never acted. These are M5's figures within a millisecond, except P1 run 3's single 133 ms frame (finding 5), which leaves every percentile within its gate. P2 runs 1 and 3 coalesced 1 and 2 drag samples.

**Recording and replay pacing** (`m6a-pace`, supporting, not the protocol). P1 at 1600×1000 was recorded for 41 s while a law was dragged every 1.5 s (98 commands, `stopped: user`), then replayed at 1× to its end. These are the worst values among the app's 5-second pacing lines:

| | Interval p95 / p99 | Step p95 / p99 | Edit p95 | Sim/wall (lowest line) | Debt dropped |
| --- | --- | --- | --- | --- | --- |
| Recording, with drags | 18 / 18 | 2 / 2 | 18 | 0.941 (the first line, whose 240-frame window still holds paused frames before Play) | 0 |
| Replaying it | 18 / 18 | 2 / 2 | none taken (every line repeats the recording's last edit window, p95 17) | 1.000 | 0 |

The replay reached the recorded end with a matching check (state `f49a04f1…`).

**Headless costs** (`tests/recordingCost.test.ts`, opt-in; Node 26's V8, not WKWebView; [m6a/recording-cost-headless.log](m6a/recording-cost-headless.log)). The P1 host step with a put every 12 steps: p95 0.77–0.88 ms without a recorder, 0.77–0.87 ms with one. The recorder adds nothing measurable. One recorded put through the real settle (preflight, apply, append): p50 0.014 ms and p95 0.037 ms for a one-leaf law (288 bytes); p50 0.088 ms and p95 0.152 ms for a 61-node law (6,617 bytes). The recorder never reserializes the record: each command is serialized once, at its preflight. A 1,000-command same-boundary batch replays in 64-command chunks of p95 0.15 ms. The exact export of a full record (2,516 compound puts, 16,773,123 bytes) takes 194 ms, once, at Save Recording.

## M1–M5 regression

| Scenario (packaged `6903cf4`) | Result |
| --- | --- |
| `m5-compose`: the Storm Bottle built from ingredients, held and released, an ingredient removed and undone, a mask and a triangle, Save As → relaunch → Open | 37 checks PASS, as in M5: the bottle held 54 bodies in the stream, 7 without its drag and 54 again with it; undo restored its expression exactly, mask included; the reopened scene's semantic digest equals the saved one; reset, cadence, invariance and the observed reset agree exactly (Shift+D), and every step's parts reconcile with `m5q.py`'s own evaluator |
| `m5-legible`: one-leaf and Storm Bottle states at 1280×800 | 3 checks PASS, as in M5: the content viewport read back 1280×800 CSS; the bottle, its support and the explained body are clear of the panels, tools, transport and switches; nothing scrolls sideways; the opened editor's top, the transport and the history are in view. The recording controls' own clearance there is `m6a-legible`'s (Recording controls) |
| `m4-trails`: 32 trails across a paused Reset and a paused Open | 6 checks PASS: 0 trails stored and 0 drawn after each, before any step; new steps record new trails |
| `m4-explain`: M4's whole visual QA (drag pocket, overlap, collision, limiter, probes, trails, filter, bounded buffers, the runtime's fixtures) | 28 checks PASS, as in M5: buffers 901,704 bytes after 10 toggle-and-reset cycles and two loads, the ones allocated at start; Shift+D on Overlap `allEqual: true` (reset, scripted reset, cadence at 30/60/144 Hz, both busy views, the observed reset), T08 588 steps reconciled, trails 1,056 samples with 0 mismatches |
| `m3-handles`: every spatial handle, undo/redo, cancel, Save As → relaunch → Open | 43 checks PASS; one synthetic release was lost and sent again (M0 finding 1's class) |
| `m3-demo`: every M3 example opened, played and edited through a handle; the collision scene's fixtures | 26 checks PASS |
| `m2-demo`: the ten-step defining demonstration with Save As → quit → fresh launch → Open | 14 checks PASS; M1's oracle at tick 600 before any edit (state `95ff02d6…`, engine `935d92ed…`); equal state and engine digests after the native reopen at ticks 600 and 1200 |
| `m2-authoring`: undo identity, presentation digests, a rejected precise value | 20 checks PASS |
| `m2-files`: five invalid imports, a canceled Save As, a refused name, a full disk, a read-only recovery directory | 19 checks PASS |
| `m2-guard`: Close, ⌘Q and Dock Quit through one guard; crash recovery; an older snapshot; Open over unsaved work | 36 checks PASS. With no recording, the guard behaves on every M2 path exactly as before |
| P0, P1, P2 | Performance (`m4-perf`, `m3-p1`) |
| The M1 oracle in Vitest (plain and under a busy view) | `95ff02d6…`/`935d92ed…` at 600, `c0871e51…`/`95c100da…` at 1200: unchanged |

## Acceptance criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | A multi-boundary drag, enable change, triangle gain and live undo, recorded, stopped and replayed from the frozen root, reach exactly the same authoritative final state at the same `(tick, cursor)` in the qualified app, without checkpoint restoration | **PASS**, natively on `6903cf4` | `m6a-record`: (3298, 32), state and engine digests equal to the recorded final check after a fresh launch, 13 checkpoints equal; Vitest T09 primary fixture equal at every settled boundary and every intermediate address; production replay restores nothing (Replay) |
| 2 | One drag is one undo entry while every consumed sample is retained; undo and later edits never change the root or the consumed prefix | **PASS**, natively | natively 25 samples in one transaction on 25 boundaries; Vitest coalescing, undo-as-later-command and the root-immutability case (every kind of later change, byte-identical root and prefix, deeply frozen) |
| 3 | Same-tick edits apply once in sequence; terminal commands apply with no further step; a zero-duration record reproduces with zero steps | **PASS**, natively | Vitest A, B, C and G; natively the same-tick groups (2549: 28, 29) and the terminal commands (3298: 31, 32) replayed to the exact end |
| 4 | Stop freezes the final cursor though another edit follows at the same tick; later reset or authoring leaves the record unchanged | **PASS**, natively | Vitest D (including an edit before finalization completed); natively the post-stop edit took cursor 33 live while the record stayed (3298, 32) |
| 5 | Replay shows every root law, untouched ones included; the newer authored scene, undo, recovery revision and paused live world stay; Return reattaches that context paused, with no reconstruction | **PASS**, natively | natively the replay's push is the root's, and `m6aq retained` finds the authoring world's digests, revision, generation and history identical, with no catch-up; Vitest Return case against a twin session, untouched root laws, recovery while replaying |
| 6 | Native save → restart → native open → root replay reaches the same final state; unsupported schema, profile, identity or malformed commands cannot overwrite work or claim exactness | **PASS**, natively | `m6a-record` session B; `m6a-guard` refusals of a malformed, a foreign-runtime and a scene file from replay, each leaving everything as it was; Vitest strict reading and transactional Open Recording |
| 7 | The recorder stops intact at 60 s, 50,000 commands or 16 MiB of complete UTF-8; refuses overflowing commands before mutation; reserves endpoint growth; ends a capped gesture at its last acknowledgment; queued edits never spill; the saved record reimports | **FAIL** on `6903cf4` (Review, F1 and F2: the record stayed intact, but a refused edit reached undo or the dirty state). **PASS** headless on `2c79d2d` | `tests/recordingLimits.test.ts` against the real host, document and coordinator, including both gesture cases; `tests/runFile.test.ts` size arithmetic and the exact import limit; natively a P1 recording closed at exactly tick 7200 (rehearsal build `fd4cab8`, supporting) and the reservation was exact by construction (18,023 reserved, 18,016 written) |
| 8 | Camera, visualization and cadence do not change equal-address replay; pause advances no tick or triangle phase; the background/resume policy holds | **PASS**, natively | natively session B replayed under probes, trails, an arrow filter, an explained body and a Hide, and matched; Vitest busy-view, cadence, pause and probe-ordering cases |
| 9 | Replay ends read-only at its frozen address; Save Scene is off there; Save Recording targets the record; the guard names and may save the retained scene, preserving the selected context on a later Cancel; every record-dropping operation protects an unsaved record; the controls distinguish their meanings; no seek control | **FAIL** on `6903cf4` (Review, F3: from replay the scene's alert did not name the main authored scene); every other clause natively. **PASS** headless on `2c79d2d`; its native check and the independent inspection are pending (below) | natively the end state, the refused ⌘S and both guard orders with their Cancels; Vitest guard matrix; the controls (Recording controls) |
| 10 | Repeated replay, restart and return free their worlds and views; at most one authoring and one replay context in steady replay, and one transient unstepped candidate during an import (a peak of three); failures and cancellations free it; a commit restores the steady count | **PASS**, natively | Shift+M in the packaged app (T11 above); Vitest T11 |

## Findings

1. **A closed recorder's record could be missed in a narrow window** (fixed, `967f560`). Right after the recorder closed itself at a limit, and before its scheduled resolution ran, `settled()` returned the previous record. The headless cost measurement found this. `settled()` now resolves the stop itself, and a regression test pins it. The app's own limit handler had always awaited after the resolution.
2. **A pre-native review of the app integration found nine defects** (fixed, `fd4cab8`; Review).
3. **The recording controls were drawn under the diagnostics overlay** (fixed, `6903cf4`). The first native captures showed the developer overlay over the bottom-left cluster, so "Recording … s of 60 s" and Stop recording were illegible. Clicks went through, because the overlay takes no pointer events. The legibility check had passed because it did not list the overlay. The cluster moved to the top right, and the body readout now starts below it. The readback reports both regions, and the check counts the overlay. Every native result in this record ran after the fix.
4. **At the 900×600 minimum window**, the replay cluster's lower edge (y 206) meets the top of the Storm Bottle's projected support (y 184) in the QA scene's framing. It is clear of every UI region. SPEC §11.1 sets the selected law's clearance at 1280×800, where every state passes. Narrow-window layout stays with M8. Informational.
5. **One 133 ms frame in P1 run 3.** The frame before it did 2 ms of work, and the next caught up with 8 steps, so the time passed outside Lawsmith's frame callback. Every percentile is within its gate (interval p99 18 ms). Informational.
6. **Exact replay is qualified per build** (by design, SPEC §13.1). The identity includes the bundle's SHA-256, so a recording made before any rebuild is refused here as incompatible, with an exact message. It is never replayed under a claim. No conversion or inspection mode was built. Informational.
7. **Laws created during a recording showed their IDs as names in replay** (fixed, `2c79d2d`, by the owner's decision on review S7). Presentation is not a command, so a replay knew only the root's names and colors. The record now carries the presentation of the laws it creates and keeps (schema 2).
8. **Discrete edits now settle at once** (Recording). This changes no boundary and no simulation result, since M5's suites pass unchanged. A toggle's `law-applied` event now comes at once rather than with the next frame. Informational.
9. **`setAmbient` has no control.** It is in the vocabulary and works end to end; nothing in the UI produces it. Informational.
10. **The recording state says "Recording" twice** (the heading and the status). It is copy only, left for the owner's inspection rather than requalified for one word. Informational.
11. **Harness slips in the first native runs** (fixed; the app was right each time). In order:
    - The first click after a recording started was lost, M5 finding 10's class. Logged controls now resend once (`press_expect`, `click_expect`), panel openers do too (`press_panel`), and a file the Open panel kept unselected is selected again (`open_panel`).
    - Run IDs kept their JSON quotes in comparisons.
    - The guard check read the freeze event instead of the choice.
    - The legibility check explained a body at tick 0, before any existed.
    - The pacing loop outlasted the 60 s limit, after which the scenario looked for a Stop that was correctly gone; its quit then answered the alerts in the wrong order.
    - One shared QA folder grew until a scene sat below the Open panel's visible rows. Each scenario now has its own.

    Every such run was discarded (Evidence provenance).
12. **The owner adjusted the display's brightness during the window.** `m4-explain` yielded at once (exit 4), as designed, and ran again in full. Informational.

Carried, not changed by M6A: the clean Dock Quit/logout policy, emitter rotation, panel height and the window jump (M8), startup compile and probes at the work limits (M9), the Tauri dialog patch and the next Tauri/TAO update, DPR across displays, M4's moving-body trackpad check and M5's Storm Bottle trackpad feel keep their owners. The guard now also protects an unsaved recording on Dock Quit, through the same `guard_state` flag; the clean-quit policy itself is unchanged.

## Review

**Pre-native review, before any native run** (one read-only Opus 5.5 code-reviewer, over `src/main.ts` at `967f560` and its use of the coordinator, replay, workflow and world view: the parts with no automated coverage). It reported two high, two medium and five low findings, all fixed in `fd4cab8`:

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| R1 | high | ⌘Z and ⇧⌘Z during replay changed the authored document and the paused authoring world: `blocked()` did not check replay | `blocked()` includes replay, which also covers every edit, toggle, shelf, label, color and setting handler |
| R2 | high | Delete during replay removed the authored law with the selected replay law's ID | the same |
| R3 | medium | The Arrows toggle stayed live in replay and changed the document; replay drew the authored arrow default | refused and disabled in replay; a replay draws its root's |
| R4 | medium | Replay probes stepped under the next boundary's laws: a unit settled n+1 before probes observed n → n+1 | a step observer runs between the step and the settle; the probe-ordering test with its negative control |
| R5 | low | Returning to a faulted authoring world hid its fault message | a switch shows the displayed world's fault |
| R6 | low | Step could take a live checkpoint before the boundary settled, and observed a step halted at a limit | Step settles first; a halted step is not observed |
| R7 | low | A body instance material leaked on every replay cycle | released with its mesh |
| R8 | low | Replay from Start had no failure path | the coordinator selects authoring and the app restores its view |
| R9 | low | The exactness note's wording could be wrong in the packaged app | worded from the actual reason |

**Acceptance review of `bf5dcd7` (code `6903cf4`)**, which the owner requested: two read-only Opus 5.5 reviewers, one hunting bugs and one auditing architecture, quality and data integrity, plus the reviewing session's own execution. In a disposable clone of `6903cf4` the session ran `npm run typecheck` (exit 0), `npx vitest run` (578 passed, 2 skipped), `cargo test` (27 passed) and `cargo check` (exit 0), each equal to this record. Its own script compared the 13 live and replay checkpoints and the final digests of both sessions, all equal. It also audited the run file's structure, hashed the bundle files on disk against the Environment table, and read the logs across the cut video intervals, finding no evidentiary gap. Its verdict was **remediation required** (AC7, AC9). The checkpoint-free oracle (root, log, terminal address, replay) had no defect. The session reproduced F1 and F2 by executing them against `6903cf4` before fixing them. Every finding is resolved on `m6a`:

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| F1 | medium | At a count or byte limit, a drag released with its last sample still queued kept an undo entry ending at that sample, which the limit then refused. The scene held −1, while Redo applied −0.5, a value it never had. A cancel whose restore was refused left its applied samples with no undo entry | `de07de9`: `DocumentController.endGesture` settles, then records from the start to the applied state; `main.ts` and the test drag both use it. Fixtures in `recordingLimits` |
| F2 | medium | An edit refused at a count or byte limit left the revision one past the saved one. A saved scene read as edited, the close guard asked to save it, and recovery wrote a copy at revision 50001, which the host never acknowledged | `fa5ea78` and `d355f37`: the controller records the revisions discarded unapplied, and `dirty` and the save's later-edits count ask `unchangedSince`. Revisions stay monotonic. The fixture in `workflow` fails before and passes after |
| F3 | medium | From replay, the scene's alert read "the changes you made to “X”" with a plain Save, while the window showed "Replay of “X”" | `e578acf`: from replay it asks "Do you want to save your main authored scene “X”?", says the replay is not part of it, and offers Save Main Scene. `m6a-guard` answers it by that button |
| F4 | low | The limit tests never ran LawInteraction's release and never checked dirty or recovery after a refusal | `a508334` (`tests/lawGesture.test.ts`), with the F1 and F2 fixtures |
| S1 | low | A fault in the replay world offered a Reset that does nothing there | `9df362a` |
| S2 | low | `LinearReplay.unsettled` scanned the rest of a boundary's group on every check | `526f08d`: the one-look `hasUnsettled`. A 1,000-command batch replays in chunks of p95 0.118 ms (headless) |
| S3 | low | `commitRun` swapped views before `commitImport` could throw | `5129592`: a running recording is refused at `prepareImport`, and the coordinator commits before any view moves |
| S4 | low | Record dropped the previous record before a rebuild that could fail | `0ee994d` |
| S5 | low | An unreadable macOS build hid inside `os`, so `qualified` counted it as known. `arch` is the build target, not a hardware model | `a47e48c` for `os`. The packaged identity's format is unchanged. `arch` stays as it is, by the owner's decision: an `aarch64` shell runs only on Apple Silicon, WebKit and the macOS build identify the runtime that computes, and a hardware key would change the strict run format for no case this one Mac can meet |
| S6 | low | `write_run` would replace any file an Open Recording token named | `d57c69b` |
| S7 | low | Laws created during a recording show their IDs in replay | `2c79d2d`, by the owner's decision, with SPEC §13.3 edited under the owner's authorization. The record carries `createdLaws`: the presentation of each law the log creates and keeps, captured at stop. Replay shows it after the root's own entries. The first command creating a law reserves that law's widest entry, so the 16 MiB budget stays exact. The strict reader accepts only entries for laws the log creates and keeps, in ID order. Schema 2. `m6a-guard` duplicates a law while recording and checks that the replay names it |
| S8 | low | That production replay restores no snapshot was checked only by a search | `256105f`: a spy on `World.restoreSnapshot` across direct, paced, restarted and imported replays |
| S9 | low | `discardPending` relied on callers having adopted acknowledgments | `d355f37` |
| S10 | low | Import accepted a limit's stop reason with an endpoint that limit cannot produce | `d9c2ec0` |
| S11 | low | The root's envelope was serialized twice at Record | `81222bf` |

Headless on `2c79d2d`:

- `npm run typecheck`: exit 0.
- `npx vitest run`: 28 files passed and 2 skipped; **591 tests passed, 2 skipped**. That is 578 plus 13 new tests: F1 3, F2 1, F4 2, S5 2, S7 4, S8 1.
- `cargo test`: 27 passed. `cargo check`: exit 0.
- `git diff --check bf5dcd7..2c79d2d`: exit 0.
- Not run: `npm run build` and the packaged app. They belong to the native re-qualification (Owner checks).

Two facts came up along the way:

- **Rapier's WASM reads `performance` from `window` whenever a `window` global exists.** A stand-in window without it made every later step panic (`unreachable`) and broke the instance for the rest of the test file. Only tests are affected, since the app has a real window. `AGENTS.md` now lists it among the stack facts.
- **The pinned three.js `TransformControls.pointerUp(null)` dispatches only `mouseUp`.** So a release at a limit sends no trailing sample.

**Independent review:** GPT-6.1 Sol's review did not run. The owner accepted M6A on the acceptance review above.

## Owner checks

- **The playback controls, inspected by someone who did not implement them** (MILESTONES M6A Visual QA). Not run before acceptance, by the owner's decision; optional now, and any wording change is a small follow-up. Steps:
  1. Open `Lawsmith.app` (packaged `6903cf4`).
  2. Open `examples/storm-bottle.lawsmith.json` (or any scene).
  3. Press **Record from tick 0**, drag the bottle into the stream for a few seconds, turn it off and on in the Laws list, press **Stop recording**.
  4. Press **Replay recording** and **Play**, and let it reach its end.
  5. Then try **Replay from start**, **Return to authoring** and **Reset** (in authoring).
  6. Judge whether each label says what it does. Can you always tell which experiment you are looking at (your scene, or the replay of the recording)? Is it clear that replay is read-only, and that **Save recording…** saves the recording and not the scene?

  Note anything ambiguous; any wording change is a small follow-up. From replay, the close guard's scene alert now reads "Do you want to save your main authored scene “…”?" with Save Main Scene (Review, F3); include it.
- **Native re-qualification of the remediated candidate** (`2c79d2d`). Not run before acceptance, by the owner's decision. It carries into M6B's first native window: on M6B's own build, run `m6a-legible`, `m6a-record`, `m6a-guard` and `m6a-pace`, which also covers M6A's run format and its replay as M6B's regression. Steps as written for `2c79d2d`:
  1. `npm run build` and `npx tauri build --bundles app` from `2c79d2d`. Record the bundle and binary hashes, and confirm the fault strings are absent from `dist/assets`.
  2. Run `m6a-legible`, `m6a-record`, `m6a-guard` (it now answers the from-replay scene alert by Save Main Scene, and checks that a replay names a law its recording created) and `m6a-pace`, then the M1–M5 regression chain, each counted run on that one build.
  3. Replace the native sections of this record with those runs.

  **One attempt, stopped by the guard.** The packaged app was built from `5653cf6` (application code `2c79d2d`; the later commits change only this record) at 20:59:53–21:00:11 on 2026-10-08:
  - `index-zUdDidmO.js`: SHA-256 `013c3d6c89e4d4b02403d3e601990a32562db5b4e92a1c98973a343a818b4947`.
  - `index-C1BU_RcZ.css`: `d8d11549ba23057ef1059ceb3a7fcc3f44ad36a0f3f29dc9afaa517fa8608db5`, unchanged.
  - `index.html`: `9e5ca47f4ce58a511b3a3a4a98de5939f06b82970ae3930a5d23fafe172f533f`.
  - Shell binary: `a4908a8804903986242929492dd4f5172b87701c877a8b0ff140f7f16aee6f0b`. `Lawsmith.app` is 13.53 MiB.
  - No fault strings are in `dist/assets`.

  The chain started at 21:00:34, in the hands-off window the owner agreed. `m6a-legible` launched the app and switched to More Space. Before its first click, the hit test found another session's screenshot interface covering the whole screen: `screencaptureui`, a full-screen window at layer 24, the menu-bar level that interactive capture uses. It refused the input (exit 3). Nothing was clicked. The display was restored to 1168×755, and the run counts for nothing. That window stayed up throughout the session, and the owner closed the session with the re-run pending. It is not a recording overlay: those sit above layer 1000, and the hit test skips only its own. Skipping this one would have sent clicks into the other session's capture.

  The build above stays valid for the re-run while no application input changes.

  **Run on M6B's build** (application code `d6966fd`, which contains `2c79d2d`; built 2026-10-08 23:16:39): `m6a-legible` 7 checks, `m6a-record` 35, `m6a-guard` 19 (Save Main Scene from replay; a replay names a law its recording created) and `m6a-pace` 3, then the M1–M5 chain, every one passing. The results and their provenance are in [M6B.md](M6B.md) (M6A, carried; M1–M5 regression).
- Carried: M4's moving-body trackpad check and M5's Storm Bottle trackpad feel.

## Evidence provenance

- **One build carried every counted native result.** The packaged app was built at 14:29:12 on 2026-10-08 from `6903cf4`. Every counted run started after it, and every counted app log opens with a `qualification` event naming that build's bundle, `index-_JsT4sJa.js sha256:4414b337…`. The commits after `6903cf4` change only `scripts/verify/native/` (`lib.zsh`, `m6a-legible.zsh`, `m6a-pace.zsh`) and this record (`git diff --name-only 6903cf4 HEAD`). After the last run, a rebuild from HEAD (`7c671b1`, `npx tauri build --bundles app`, 15:52:01) reproduced the four hashes in the Environment table byte for byte, with the fault strings absent from `dist/assets`.
- **Two chains, inside one hands-off window**, which the owner agreed at 14:12 ("you drive, I step away"). The first used the harness at `b588d29`: `m6a-legible` 14:31:05–14:32:06; `m6a-record` 14:32:07–14:37:15; `m6a-guard` 14:37:16–14:39:53; `m4-trails`, `m4-perf` and `m3-p1` 14:42:08–14:55:51; `m3-handles` 14:58:53–15:02:29. The second used the harness at `7c671b1`, each scenario in a new QA folder of its own: `m6a-pace` 15:05:15–15:07:22; `m3-demo`, `m2-demo`, `m2-files`, `m2-guard` and `m2-authoring` 15:14:00–15:31:35; `m5-compose` and `m5-legible` 15:31:36–15:40:51; `m4-explain` 15:40:55–15:50:34. The harness resent 13 lost synthetic events once each, and the app's log then showed each one arrive (M0 finding 1's class): 12 releases (`m4-perf` 9 among its P0 and P2 drags, `m3-p1` 1, `m3-handles` 1, `m6a-pace` 1) and one click on the Probes switch in `m6a-record`. The logs in `m6a/native/` are these runs': each M6A scenario's app logs and step log, and the regression scenarios' as `r-<scenario>-…`.
- **Discarded attempts on the candidate** (not cited; logs not published; finding 11): `m6a-pace` at 14:39:54, whose replay matched at (4917, 96) but whose quit expected the recording's question first, where authoring asks about the scene first; `m4-explain` at 14:55:53 after 10 passing checks and `m3-demo` at 15:02:30 after 5, each when the shared QA folder's next scene sat below the Open panel's visible rows; `m2-demo` at 15:04:23, stopped after 3 passing checks so the rest could run in folders of their own; and `m4-explain` at 15:07:23, which yielded after 19 passing checks when the owner adjusted the display's brightness (finding 12) and then ran again in full.
- **Rehearsals** (never cited): on `fd4cab8`, 14:13–14:26, `m6a-record` (three attempts, the third complete), `m6a-guard`, `m6a-legible` and `m6a-pace`, whose P1 recording closed at exactly tick 7200 (AC7, supporting); on `6903cf4`, 14:29:24–14:30:14, an `m6a-legible` that failed at 900×600 because its gate counted the selected law's support, which SPEC §11.1 sets at 1280×800. The check now gates the minimum window on UI regions and reports the support (`b588d29`; finding 4).
- **Recordings and captures.** Captures are window captures (`screencapture -l`), which show only Lawsmith's window. Recordings capture the window's screen rectangle, so each was reviewed frame by frame at one frame per second and again at two after cutting. The published two are cut. `m6a-record.mp4` drops 32–40 s, where another application's notification banners crossed the window while recording was paused. `m6a-replay.mp4` drops 2–9.6 s, the Open panel, whose sidebar names the account and the Mac, and 21.8–25.4 s, where a terminal window covered Lawsmith's while the replay played. Session B's log carries the whole replay, its address and its check. The regression scenarios' recordings are not published. Screen recording was off for P0, P1, P2 and `m6a-pace`.
- **Logs** keep only `[lawsmith]` lines and the harness's step lines. They were checked for credentials, personal paths, user and host names before publishing, and none appear. The app's runtime record names its recovery directory only as `override`. The run file `m6a/m6a-qa.lawsmith-run.json` is the one `m6a-record` saved natively (18,016 bytes), byte for byte.
- **State the QA touched, restored.** Recovery directories were per run (`LAWSMITH_RECOVERY_DIR`) under a disposable folder, and scenes and run files lived in disposable folders. `m2-files` used a 1 MiB disk image created by `m2-stage.zsh`. It was still attached after the chain, and was detached then. The display read 1168×755@120 before QA. It was at More Space only during `m6a-legible`, `m6a-pace`, `m4-perf`, `m3-p1` and `m5-legible`, each restoring it, and it read 1168×755@120 at the end. Lawsmith's panel preferences domain existed before QA, empty. After the last run the three file-panel keys QA's Open and Save panels wrote to it were deleted, leaving it empty again. No test instance, recorder or holder of the shared GUI lock was left running.

## Scope confirmation

M6A adds the RunRecord and its file, the recorder with its limits and preflight, the checkpoint-free linear replay, the run coordinator with one retained authoring context and one replay context, native Save and Open Recording, the two-artifact guard, the recording controls and the evidence fixtures. It adds no checkpoint capture or restoration (`World.restoreSnapshot` is not called anywhere), checkpoint cache or sidecar, nearest-checkpoint selection, seek, scrubbing or timeline thumb, reverse integration, mid-run recording root, editing of recorded commands, branching, baseline, ghost, export of alternates, engine download, cloud storage, new field primitive or operator, worker, GPU simulation or probe, or dependency change. **M6B NOT STARTED.**


