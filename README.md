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

`scripts/verify/verify.sh native <scenario>` drives the packaged app the way a person would: real handle drags, the real macOS Open and Save panels, Close, Quit and Dock Quit, a simulated crash. It checks every step against the app's own `[lawsmith]` log events. The M2 scenarios are `m2-demo`, `m2-files`, `m2-guard`, `m2-authoring` and `m2-p0`; `m2-p0` switches the built-in display to its More Space mode for the login session and restores it on exit. `python3 scripts/verify/native/m2-summary.py LOG…` summarizes open, save and recovery timings from their logs. The scenarios need `QA_STATE` (a disposable directory holding the test scenes and recovery directories) and `QA_OUT` (where logs, captures and the recording go); `scripts/verify/native/lib.zsh` documents the fixtures each one expects.

Input is guarded. Every click is hit-tested against the Lawsmith process under test; keys require it to be frontmost; any keyboard or mouse input newer than the harness's own aborts the run, so it never fights a person. Each focus-changing segment holds an exclusive `flock` on `/private/tmp/mac-gui-automation.lock`, which other automation on the same Mac also takes. The Open and Save panels start in a folder the harness seeds in Lawsmith's own preferences, so they never navigate; remove those preferences afterwards with `defaults delete local.lawsmith` if they did not exist before.

## Controls

Drag a law's handles in the viewport: <kbd>T</kbd> move, <kbd>R</kbd> rotate, <kbd>S</kbd> extent. Click a law, or its row in the Laws list, to select it; the details below the list take precise values. <kbd>F</kbd> frames the selected law; Reset view restores the starting camera. <kbd>Space</kbd> plays or pauses, <kbd>.</kbd> advances one step, <kbd>Shift</kbd>+<kbd>R</kbd> resets the current configuration to tick 0. <kbd>Esc</kbd> cancels a drag in progress, or deselects. <kbd>⌫</kbd> deletes the selected law. The simulation pauses whenever the window loses focus and waits for Play.

Scenes are `.lawsmith.json` files: <kbd>⌘O</kbd> opens one, <kbd>⌘S</kbd> saves, <kbd>⇧⌘S</kbd> saves as, <kbd>⌘Z</kbd> and <kbd>⇧⌘Z</kbd> undo and redo law edits. Save keeps the setup (laws, bodies and emitters), not the current motion; an opened scene starts paused at tick 0. Unsaved work is kept in a recovery copy and offered at the next launch. Closing or quitting with unsaved changes asks to Save, Don't Save or Cancel.

## Diagnostics

In the running app, <kbd>Shift</kbd>+<kbd>D</kbd> runs the reset and cadence fixtures in that runtime and logs a `fixtures` line. <kbd>Shift</kbd>+<kbd>P</kbd> starts a P0 capture: it plays, warms up for 10 s, measures for 60 s, and logs a `p0-run` line with percentiles and every raw sample. Every run logs `run-digest` lines with SHA-256 of the authoritative state and the engine snapshot at ticks 600 and 1200. In dev only, <kbd>Shift</kbd>+<kbd>G</kbd> stalls the main thread for 1.5 s to exercise the long-gap pause.
