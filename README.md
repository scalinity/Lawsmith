# Lawsmith

A three-dimensional playground in which physical laws are visible, spatially manipulable objects. Native macOS app: Tauri 3 (prerelease, exactly pinned) with a TypeScript/Three.js WebGPU frontend in the system WKWebView. Product and engineering contracts live in [docs/SPEC.md](docs/SPEC.md); milestones and acceptance gates in [docs/MILESTONES.md](docs/MILESTONES.md).

## Prerequisites

- macOS on Apple Silicon, with Xcode command-line tools
- Node.js and npm (qualified with Node 26.10.0, npm 12.2.0)
- rustup; `rust-toolchain.toml` pins Rust 1.99.0 and rustup installs it on first use

## Commands

```sh
npm ci                                  # install the locked frontend and CLI dependencies
npm run typecheck                       # strict TypeScript check
npm test                                # Vitest: field, adapter, reset, cadence, scene format, undo and workflow tests
(cd src-tauri && cargo test)            # native file replacement and recovery store tests, in temporary directories
scripts/verify/verify.sh unit           # all of the above in one command
npx tauri dev                           # development app: WKWebView on the Vite dev server
npx tauri build --bundles app           # production build of Lawsmith.app
open src-tauri/target/release/bundle/macos/Lawsmith.app
```

The packaged app embeds its frontend assets and needs no dev server, network connection, account or key.

At startup the app writes one JSON qualification line per event to stderr, prefixed `[lawsmith]`. To capture them from the packaged app:

```sh
open -n src-tauri/target/release/bundle/macos/Lawsmith.app --stdout lawsmith.log --stderr lawsmith.log
```

`LAWSMITH_RECOVERY_DIR=<dir>` points recovery files at a separate directory, so QA runs never touch your own unsaved-work recovery (by default it lives in the app's local data directory). For the packaged app: `open -n …/Lawsmith.app --env LAWSMITH_RECOVERY_DIR=/path/to/dir --stdout lawsmith.log --stderr lawsmith.log`.

Dev-only startup fault injection, compiled out of production builds: `VITE_LAWSMITH_FAULT=webgl npx tauri dev` forces the WebGL 2 backend; `VITE_LAWSMITH_FAULT=rapier-hang npx tauri dev` stalls physics initialization until its timeout.

## Native verification

`scripts/verify/verify.sh native <scenario>` drives the packaged app the way a person would: real handle drags, the real macOS Open and Save panels, Close, Quit and Dock Quit, a simulated crash. It checks every step against the app's own `[lawsmith]` log events. The M2 scenarios are `m2-demo`, `m2-files`, `m2-guard`, `m2-authoring` and `m2-p0`; `m2-p0` switches the built-in display to its More Space mode for the login session and restores it on exit. `python3 scripts/verify/native/m2-summary.py LOG…` summarizes open, save and recovery timings from their logs. Later milestones add `m3-*`, `m4-*` and `m5-*` scenarios; M5's are `m5-compose` (building and manipulating a compound law, through save and reopen), `m5-perf` (the P5 compound workload) and `m5-legible` (1280×800), with `m5q.py` recomputing every ingredient share from the app's log. M6A's are `m6a-record` (a real intervention recorded, saved, and replayed exactly after a fresh launch, with `m6aq.py` comparing the two sessions), `m6a-guard` (the scene-and-recording guard and imports from a replay), `m6a-legible` (the recording controls at 1280×800 and at the minimum window) and `m6a-pace` (P1 while recording and while replaying). M8's are `m8-visual` (the five examples at 1280×800 and 900×600 and 100/150/200% Interface Scale, overlapping selection, long names, near-zero and saturated arrows, the collapsed panel, comparison and fault states and window dragging, with `m8q.py` asserting each layout readback) `m8-keyboard` (a keyboard-only session with native Save and Open at 1280×800 and 200%) and `m8-perf` (P0, P1, P2 and P3 under SPEC §18.2 with the final default visuals: 1600×1000 CSS at a 1.5 pixel-ratio cap and exactly 60 Hz, 10 s warmup and three independent 60 s captures each, recording off, with `m8perf.py` checking every capture against the gates from its raw samples); all three also need `QA_DEADLINE`, each scenario's safety deadline in epoch seconds inside a batch the owner has authorized (see `AGENTS.md`, Native QA), after which they send no input. The scenarios need `QA_STATE` (a disposable directory holding the test scenes and recovery directories) and `QA_OUT` (where logs, captures and the recording go); `scripts/verify/native/lib.zsh` documents the fixtures each one expects.

Input is guarded. Every click is hit-tested against the Lawsmith process under test; keys require it to be frontmost; any keyboard or mouse input newer than the harness's own aborts the run, so it never fights a person. Each focus-changing segment holds an exclusive `flock` on `/private/tmp/mac-gui-automation.lock`, which other automation on the same Mac also takes. The Open and Save panels start in a folder the harness seeds in Lawsmith's own preferences, so they never navigate. Before seeding, under the lock, the harness snapshots the `local.lawsmith` domain into `QA_STATE` (which must lie outside the repository); `restore_preferences` puts that snapshot back exactly, or removes the domain only if it did not exist, and records the outcome in `QA_OUT/cleanup.jsonl`. Only `defaults`' exact not-found answer counts as absence; any other read failure stops the run before anything is written, and fails a restore. The M8 scenarios restore on exit; earlier scenarios leave restoring to their caller. With `QA_DEADLINE` set (epoch seconds, required by the M8 scenarios), no input or native change starts that could end after it, and the lock and quiet waits give up at it.

## Performance envelope (M9)

**Status: unmeasured; native qualification deferred to M10 by owner on 2026-10-13.** The figures below are targets, not results. M10 must execute the remaining M9 performance/resource checks alongside its full acceptance suite. Earlier milestones' P0–P3 records belong to earlier builds; no supported envelope is declared until fresh packaged-candidate measurements are recorded. See [M9 carry-forward](docs/evidence/M9.md#owner-directed-deferral-to-m10--2026-10-13).

**What is targeted versus what is merely allowed.** The supported envelope is SPEC §18's named workloads in the packaged app:

| Workload | Scene |
| --- | --- |
| P0 | Sideways Rain, at most 64 bodies and 125 arrows |
| P1 | 200 dynamic bodies, 16 one-leaf laws, 16 fixed colliders and contacts, 32 trails |
| P2 | 100 bodies, 4 laws, 2,000 CPU probes, 32 trails |
| P3 | 100 bodies, 4 laws, a 600-tick baseline built in at most 3 s, and active comparison playback over a 7,200-tick baseline |

SPEC §15.2's import limits are a different thing: work safeguards, not a promise that the scene runs at full rate. The limits are 512 live bodies, 32 laws, 256 primitive leaves, 64 nodes and depth 8 per law. A scene near them may run slower than real time; the status line then says so (it never shortens the step or drops ticks) and its optional visualization may need reducing.

**Gates**, per workload at 1600×1000 CSS, a 1.5 pixel-ratio cap, 100% Interface Scale, the HUD shown and 60 Hz:

| Gate | P0 | P1–P3 |
| --- | --- | --- |
| Completed step p95 / p99 | ≤ 2 / ≤ 4 ms | ≤ 3 / ≤ 5 ms |
| CPU frame work p95 | ≤ 12 ms | ≤ 14 ms |
| Frame-callback interval p95 / p99 | ≤ 20 / ≤ 34 ms | ≤ 20 / ≤ 34 ms |
| Accepted edit to frame submission p95 | ≤ 50 ms | ≤ 50 ms |
| Simulated/wall time | ≥ 0.98 | ≥ 0.98 |

Budgets: trace and probe buffers under 32 MiB, the checkpoint cache and the comparison each within 64 MiB. Frame-callback intervals are a pacing proxy, not presented frames. CPU submission is timed; GPU execution is not, and the record says whether the device exposes timestamp queries.

**Procedure.** `scripts/verify/native/m9-batch.zsh` runs the owner-approved batch: `m9-smoke`, `m9-resources`, `m9-perf P1 P2 P3 P0`, then `m9-limits`. Approval is passed as `QA_APPROVAL` and `QA_APPROVED_SCENARIOS`. The driver holds the shared GUI lock for the whole batch, gives each scenario a finite watchdog, stops at the first failure or any outside input, and checks and restores the display and preferences itself.
- **`m9-perf`**: each workload in its own packaged launch, with three captures of 10 s warmup and 60 s measured. P3 follows SPEC §18.2's order in every capture: fork, the 600-tick baseline measured on its own, a warmed disposable continuation, the fork restored, the 7,200-tick baseline precomputed, then 60 s of playback.
- **`m9-resources`**: Shift+Y runs 20 scene-load/reset cycles and checks equal-tick authority under visualization. A 60 s P1 recording follows, with real drags. Its read-only replay is checked, and an uncached seek is canceled from its control. Shift+U then runs 20 seek → fork → close → return cycles against the checkpoint-free oracle.
- **`m9-smoke`**: 1280×800 at 60 Hz and the Retina display at 120 Hz.
- **`m9-limits`**: one separate characterization of the M5 maximum-work scene (32 laws, 256 leaves, 57 nodes/depth 8 per law) with 2,000 probes and 32 trails. Its figures do not declare supported capacity or admit compute.
- **`m9perf.py`**: recomputes every percentile and simulated/wall from raw samples, checks P3's setup order, and fails on any missing or malformed data. Its parser controls are `test_m9perf.py`; the driver's are `test_m9_batch.zsh`.

First-frame times are reported for every launch, with the WebKit cache state not controlled: they are neither cold nor warm figures.

## Controls

The window is one surface. The scene card at the top left holds the scene's name, its file actions and **Open an example…**; below it the Laws list, Motion and Display settings scroll on their own, and **Hide laws** collapses them completely. Any simulation error, recording and replay, the comparison, the selected law's details and the explained body stack at the top right and scroll together; **Hide details** folds the law's details to their title line. Play, Step, Reset and **Draw options** sit at the bottom right. The drawing options (arrows, probes and trails) start folded at every size; Draw options opens or folds them, and that choice holds when the scale or window changes. The recording card shows only the actions its state needs; **More** shows the rest. Above 100% Interface Scale in a window narrower than about 1,100 interface units, or in a short window, everything joins one scrolling column on the left, in the order Laws, Details, Scene, Recording, with a bar at its top that jumps to each section and moves keyboard focus to its heading; the right side keeps only an error or a running condition. The empty top band moves the window; it never covers a control, a law or the canvas.

**Open an example…** offers five editable scenes: Sideways Rain, Catch and Release, Drag Pocket, Storm Bottle and Two Futures. Each opens paused at tick 0 through the same unsaved-work question as New, with its law selected and a one-line suggestion for what to try. Drag Pocket's bumper and floor show what the laws contributed to a body apart from the collisions that also moved it: click a body after it lands.

Every law is named over its support in the viewport, so identity never rests on color alone: the selected law's name is underlined and a disabled law reads "off". Click where laws overlap to select the nearest; click again to reach the one behind it. **Interface scale** (Display, or <kbd>⌘+</kbd>, <kbd>⌘−</kbd> and <kbd>⌘0</kbd>) sets text and controls from 100% to 200%; panels reflow and scroll, and neither the simulation nor the rendering resolution changes. With Reduce motion on in macOS, the camera stops as soon as an orbit ends. Every action has a labeled control with a visible focus ring. <kbd>Tab</kbd> moves between fields and buttons alike, whatever Keyboard navigation is set to in macOS, and <kbd>Space</kbd> presses the focused button. Text fields keep normal macOS editing, and typing in them never triggers the viewport's single-key shortcuts.

Drag a law's handles in the viewport: <kbd>T</kbd> move, <kbd>R</kbd> rotate, <kbd>S</kbd> extent. Click a law, or its row in the Laws list, to select it; its details on the right take precise values. A law can combine primitives: its Ingredients row adds a push, pull, swirl or drag to it, and it stays one law that moves, turns and resizes as a whole. Select an ingredient to edit its parameters, give it a gain (constant, or a triangle that rises and falls over ticks) or a mask that limits where it acts; Remove takes it out and <kbd>⌘Z</kbd> puts it back. In Adjust mode a selected ingredient brings its own handles and its masks'. <kbd>F</kbd> frames the selected law; Reset view restores the starting camera. <kbd>Space</kbd> plays or pauses, <kbd>.</kbd> advances one step, <kbd>Shift</kbd>+<kbd>R</kbd> resets the current configuration to tick 0. <kbd>Esc</kbd> cancels a drag in progress, or deselects. <kbd>⌫</kbd> deletes the selected law. <kbd>H</kbd>, or **Hide HUD** beside Draw options, hides every panel, toolbar and label so only the scene shows; <kbd>H</kbd> or <kbd>Esc</kbd> brings them back as they were. While it is hidden, <kbd>Space</kbd> and <kbd>.</kbd> still play and step, the camera still orbits, and a click neither selects nor explains. <kbd>⌘O</kbd>, <kbd>⌘S</kbd>, <kbd>⌘Z</kbd>, a file action, an error, a fault, a recording limit or the save question bring the panels back. <kbd>H</kbd> does nothing while a law is being dragged; release it first. <kbd>⌘H</kbd> stays the system's Hide. The simulation pauses whenever the window loses focus and waits for Play.

**Record from tick 0** (top right) starts a new experiment: the motion resets to tick 0, your laws keep their values, and every change you make is recorded as it is applied. **Stop recording** freezes it at that exact tick; later changes are not part of it. A recording holds at most 60 simulated seconds, 50,000 changes or 16 MiB, and stops by itself at the first limit. **Replay recording** rebuilds the recording's starting scene in a separate world and plays back what you changed, read-only, without touching your scene; at its end it checks itself against the recorded final state. **Replay from start** begins it again; **Return to authoring** brings back your scene exactly as you left it, paused. Recordings are `.lawsmith-run.json` files: **Save recording…** and **Open recording…** handle them, apart from scenes. A recording replays exactly only in the build and runtime that made it; a recording from another one is refused, never replayed as exact. Closing or quitting asks separately about an unsaved scene and an unsaved recording; a recording is not kept for recovery.

**Compare from here** preserves a healthy paused scene or replay at its exact tick and consumed-change cursor. Stop an active recording and finish any seek or gesture first. It starts calculating A for five simulated seconds at once; **Cancel baseline** stops it and **Compute baseline** starts it again. Edit B's laws, then use Play/Pause or Step to compare them at the same tick. A is outlined, B solid, and the readout pairs bodies by stable identity and names absent counterparts. Neither future inherits a source recording's later human edits. **Replay Alternate** restores the fork and replays the consumed interventions, returning to editing at their retained end; **New Alternate — clear edits** restores the fork and clears its interventions and local undo. **Extend baseline +5 s** continues the actual baseline, to at most 60 seconds from the fork, within a separately accounted 64 MiB comparison budget. At the computed horizon playback pauses. **Close comparison** restores the paused source. **Export Alternate Setup…** writes a normal tick-zero scene with source body/emitter definitions and B's current laws; it does not save a comparison resume point or interventions, or replace the main scene's file binding. Comparisons remain session-local and are not recovered after exit.

Open Two Futures from **Open an example…** (or `examples/two-futures.lawsmith.json`) for a collision-free example. Set Sideways strength from 0 to 2 after the fork: at 120 ticks the traveler separates vertically by at least 0.5 m, with no acceleration limiting. The independent continuous expectation is 1 m vertical displacement at one second; the locked discrete-step tolerance is `2/120 + 0.0001 m`. Angular motion is retained in both futures.

M7 native qualification uses `m7-compare` for the workflow/captures and `m7-perf` for P3. Shift+J explicitly runs disposable independent complete-state fixtures in the packaged runtime. In a comparison, Shift+K computes the full 7,200-tick horizon. Shift+P, from a fresh comparison holding only A's default 600-tick baseline, follows SPEC §18.2's order: ten seconds of warmup in a disposable continuation (restored from the fork whenever it reaches A's horizon), the fork restored, the full 7,200-tick baseline precomputed, then 60 seconds measured with the app's periodic resolved law edits. P3 is measured by `m9-perf`; `m7-perf` and `m8-perf` record the earlier order and do not apply to this build. Numeric capture keeps screen recording off. The P3 fixture contains 100 dynamic spheres and four active directional laws; ambient acceleration cancels their common drive so bodies remain visible. Its measurements describe callback pacing and CPU submission, not input-to-photon or GPU execution time.


Scenes are `.lawsmith.json` files: <kbd>⌘O</kbd> opens one, <kbd>⌘S</kbd> saves, <kbd>⇧⌘S</kbd> saves as, <kbd>⌘Z</kbd> and <kbd>⇧⌘Z</kbd> undo and redo law edits and emitter changes. The Scene panel's **Emitter** block sets how many bodies the emitter makes per second and how many seconds it keeps each one. Values become whole ticks, and the block shows the exact result; **Apply and reset** rebuilds the scene from tick 0, and Undo restores the previous rate and lifetime the same way. Bodies always have a finite lifetime (up to an hour), and the block is locked while recording, replaying or comparing. A locked block says why and offers the control that ends the lock: Stop recording, Return to authoring or Close comparison. Save keeps the setup (laws, bodies and emitters), not the current motion; an opened scene starts paused at tick 0. Unsaved work is kept in a recovery copy and offered at the next launch. Closing or quitting with unsaved changes asks to Save, Don't Save or Cancel.

## Diagnostics

The developer readout (tick, counts, pacing, backend) is off by default; **Display → Developer readout** shows it at the bottom left. Whether or not it is open, a status line at the top right says when births are skipped at the scene's body limit, when the acceleration limit is scaling laws down, and when play runs slower than real time. In the running app, <kbd>Shift</kbd>+<kbd>D</kbd> runs the reset and cadence fixtures in that runtime and logs a `fixtures` line. <kbd>Shift</kbd>+<kbd>P</kbd> starts a P0 capture: it plays, warms up for 10 s, measures for 60 s, and logs a `p0-run` line with percentiles and every raw sample. <kbd>Shift</kbd>+<kbd>M</kbd>, with a finished recording, runs M6A's fixtures in that runtime: the linear replay run twice from the root and compared at every step and against the recorded end, then 20 replay/return cycles, 20 restarts and 20 imports with their world and render-resource counts (`m6a-fixtures`). Every run logs `run-digest` lines with SHA-256 of the authoritative state and the engine snapshot at ticks 600 and 1200. In dev only, <kbd>Shift</kbd>+<kbd>G</kbd> stalls the main thread for 1.5 s to exercise the long-gap pause.
