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
npm test                                # Vitest: field, adapter, reset and cadence fixtures
npx tauri dev                           # development app: WKWebView on the Vite dev server
npx tauri build --bundles app           # production build of Lawsmith.app
open src-tauri/target/release/bundle/macos/Lawsmith.app
```

The packaged app embeds its frontend assets and needs no dev server, network connection, account or key.

At startup the app writes one JSON qualification line per event to stderr, prefixed `[lawsmith]`. To capture them from the packaged app:

```sh
open -n src-tauri/target/release/bundle/macos/Lawsmith.app --stdout lawsmith.log --stderr lawsmith.log
```

Dev-only startup fault injection, compiled out of production builds: `VITE_LAWSMITH_FAULT=webgl npx tauri dev` forces the WebGL 2 backend; `VITE_LAWSMITH_FAULT=rapier-hang npx tauri dev` stalls physics initialization until its timeout.

## Controls

Drag the law's handles in the viewport: <kbd>T</kbd> move, <kbd>R</kbd> rotate, <kbd>S</kbd> extent. <kbd>F</kbd> frames the selected law; Reset view restores the starting camera. <kbd>Space</kbd> plays or pauses, <kbd>.</kbd> advances one step, <kbd>Shift</kbd>+<kbd>R</kbd> resets the current configuration to tick 0. <kbd>Esc</kbd> cancels a drag in progress, or deselects. The simulation pauses whenever the window loses focus and waits for Play.

## Diagnostics

In the running app, <kbd>Shift</kbd>+<kbd>D</kbd> runs the reset and cadence fixtures in that runtime and logs a `fixtures` line. <kbd>Shift</kbd>+<kbd>P</kbd> starts a P0 capture: it plays, warms up for 10 s, measures for 60 s, and logs a `p0-run` line with percentiles and every raw sample. Every run logs `run-digest` lines with SHA-256 of the authoritative state and the engine snapshot at ticks 600 and 1200. In dev only, <kbd>Shift</kbd>+<kbd>G</kbd> stalls the main thread for 1.5 s to exercise the long-gap pause.
