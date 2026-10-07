# Lawsmith — Executable Milestone Plan

**Version:** 1.0 · **Date:** 2026-10-05 · **Status:** accepted plan  
**Authority:** [SPEC.md](SPEC.md) · **Milestones:** 12 gates: M0–M5, M6A, M6B, M7–M10 · **Implementation status:** each milestone's record in [evidence/](evidence/)

This plan builds a personal creative instrument delivered as **`Lawsmith.app`, a Tauri 3 macOS application (prerelease line, exactly pinned) with a TypeScript/Three.js frontend in the system WKWebView**. Its order is deliberate: qualify the smallest native shell, make a law bend a stream, make that experiment portable, then deepen vocabulary, explanation, composition and replay. **WebGPU-first graphics are present from M0 through Three.js WebGPURenderer. TSL is the preferred GPU authoring layer.** Advanced GPU evaluation/simulation remains conditional on measured need; raw WGSL requires a demonstrated reason to drop below TSL. Rust stays thin and simulation remains frontend-owned. No source code, repository, or implementation milestone is created by this specification session.

## How to execute this plan

SPEC.md owns product semantics, equations, state boundaries, timing, formats, and supported-domain limits. This file owns scope, dependencies, deliverables, tests, and acceptance evidence. An agent must read both before starting a milestone. A contradiction is resolved in the two documents before accepting affected work; do not silently choose whichever interpretation is easier to implement.

Each milestone starts from the accepted predecessor. Work proceeds through `NOT STARTED → IN PROGRESS → IMPLEMENTED / REVIEW PENDING → ACCEPTED`; `BLOCKED` records a concrete unmet gate. These are suggested report labels, not a workflow system to build.

All acceptance criteria are conjunctive unless explicitly marked conditional. A performance target is not a measured result. A missing native visual check remains pending. Do not claim a pass because a test was planned, a screenshot resembles a mockup, or a different build passed. Browser/headless harnesses support development; actual Tauri/WKWebView evidence qualifies the application. Safari.app is not a release blocker, Chrome is not a substitute, and Windows/Linux are outside the initial target.

References to T01–T12 require only cases for capabilities implemented through the current milestone unless explicitly stated otherwise. Later test cases do not pull future features into an early gate. M10 requires the complete implemented acceptance suite. Reuse existing evidence when its candidate, affected code, settings and workload remain unchanged; repeat measurements to resolve a concrete change or uncertainty.

Throughout these gates, edit latency means accepted input to the first frame submission containing its applied revision; frame interval means the foreground frame-callback pacing metric in SPEC §18. Neither is a physical input-to-photon claim. Primary graphics measurements identify an actual WebGPU backend in the packaged app. Native automation follows SPEC §17.3: any optional macOS embedded WebDriver route must be Tauri 3-compatible and qualified before use, is distinct from Playwright/browser harnesses, and test-only instrumentation is absent from release performance/visual evidence. M0 requires no E2E framework setup.

### Minimal evidence format

Keep one compact evidence entry per milestone with:

- Candidate commit and scope/diff summary once a repository exists; name its accepted base.
- Tested application/runtime identity, dev/package/test-instrumented mode, exact commands, outcomes, and relevant numerical fixture results.
- A short continuous interaction recording and a few legible screenshots from the actual Tauri app where required; identify any browser harness evidence separately.
- Named workload and performance measurements where required.
- Known limitations, remaining failures, and any specification changes.

Do not create separate approval packets for every ordinary edit. Independent review should inspect immutable candidates at M2, M5, M7 and M10; independent complete-state review at **M6B before M7** is strongly recommended. M0/M1 can use a small local implementation review plus the required evidence. If a gate fails, fix the bounded cause and rerun affected checks. Do not re-review unrelated accepted systems without evidence of a regression.

### Delegation rule

Any capable frontier coding agent may implement a milestone. Delegate only bounded tasks with an accepted input contract, owned files, expected output, and tests. Shared semantic interfaces are agreed before parallel integration. A useful split from M3 onward is kernel/tests versus UI/visuals, with one integrator owning the host/document boundary. Reviewers should be independent of the implementation they assess. Model names do not confer acceptance authority.

No milestone requires several simultaneous agents, a generic agent framework, or an owner decision for routine reversible choices. Changes to equations, replay promises, serialization semantics, or the approved scope require an explicit documented decision. Repository publication, deployment, or unrelated external actions require their own authorization when not already requested.

## Roadmap and dependency graph

| Milestone | Visible capability | Dependency | Principal contracts |
| --- | --- | --- | --- |
| M0 | Launch the native full-window spatial workspace on confirmed WebGPU. | Owner accepts specification | C3, C10 |
| M1 | Grab sideways acceleration and bend a falling stream. | M0 | C1–C6 |
| M2 | Save, reopen, undo, and complete the defining demo. | M1 | C3, C7, C8 |
| M3 | Experiment with a small tactile vocabulary of laws. | M2 | C1, C2, C4, C5 |
| M4 | See why individual bodies change motion. | M3 | C4, C5 |
| M5 | Build and manipulate one compound law. | M4 | C1, C2, C4, C8 |
| M6A | Record interventions and reproduce them exactly from the frozen root. | M5 | C5–C8 |
| M6B | Restore complete checkpoints and seek against the trusted linear reference. | M6A | C5–C8 |
| M7 | Change one law and compare two futures. | M6B | C4, C7, C9 |
| M8 | Use a coherent creative instrument with inviting examples. | M7 | C1–C4, C7 |
| M9 | Establish and meet the supported performance envelope. | M8 | C4–C6, C10 |
| M10 | Demonstrate a verified flagship release candidate. | M9 | All |

The integration path is sequential because each capability uses the preceding contracts: **M0 → M1 → M2 → M3 → M4 → M5 → M6A → M6B → M7 → M8 → M9 → M10**. M6A's uninterrupted replay is M6B's oracle; accepted M6B is a prerequisite for M7. Bounded work inside a milestone can proceed in parallel. M9 may accept **WebGPU rendering with CPU/WASM simulation and no additional worker/GPU-compute subsystem**. There is no renderer-migration milestone; WebGL 2 is only optional compatibility provided by the same renderer and never passes the primary native WebGPU gate.

## M0 — Qualify the native spatial workspace

### Objective

Create the minimum Tauri 3 macOS app that renders through Three.js WebGPURenderer on its confirmed WebGPU backend inside WKWebView, preserves a full-window surface and native controls, and initializes Rapier. Clear the runway for M1.

### Why now

The first real product test needs a proven native runtime. A browser scene cannot qualify the packaged origin, native window or WKWebView. Nothing in M0 should consume the session that should produce M1's live field.

### In scope

- Minimal application on an exactly pinned Tauri 3 prerelease family, selecting its WRY runtime with one WKWebView window; Vite/strict TypeScript frontend, npm/Cargo lockfiles and recorded native/frontend toolchain, including the resolved Tauri component versions.
- SPEC §11.1's full-window presentation: native decorations/traffic lights retained, overlay content, hidden visible title, no reserved titlebar band, local invisible drag region.
- Pinned Three.js r183+ `WebGPURenderer`, compatible `three/webgpu`, `three/tsl` and addons, asynchronous initialization, camera and simple spatial frame with a normal node material and small visible TSL expression.
- Temporary TransformControls object sufficient to test real translate/rotate pointer handling, plus resize, Retina/DPR and basic frame pacing.
- Asynchronous `rapier3d-compat` initialization with a clear failure state; initial separation of viewport setup from a tiny simulation-host entry point.
- Actual backend/origin/runtime diagnostics as in SPEC §3.3 and §13.1, and effective engine profile settings from SPEC §9.
- One Tauri production `.app` build using embedded frontend assets, launched with the development server stopped and no external runtime network dependency.

### Out of scope

Scene serialization/recovery, native document dialogs, full native menus, recent documents, updater, installer engineering, distribution signing/notarization unless necessary for local execution, settings architecture, native E2E framework setup, platform abstraction, Electron, Tauri's CEF or any alternate webview runtime, M2-or-later Tauri plugins, Windows/Linux support, native Rust simulation, advanced plugins, lifecycle framework, fields, AST, history, workers, GPU compute, raw WGSL/GLSL, a separate WebGLRenderer path, ECS, elaborate CI, server or deployment. Do not create empty extension modules. Default native menu/window behavior is enough; simple node materials do not require a shader framework.

### Deliverables

A minimal launchable project with the two lockfiles, documented Tauri dev/build/launch commands, actual local `Lawsmith.app`, a visible spatial frame and initialized engine, plus a short native qualification record. This describes future M0 work; it is not authorization to create a repository or implement Tauri during specification authoring.

### Acceptance criteria

1. With documented macOS prerequisites, a fresh checkout installs with locked dependencies, type-checks, runs the Tauri development app and produces a launchable Apple Silicon `.app`.
2. Both the development Tauri app and packaged production app render the real node/TSL scene inside WKWebView on the owner's supported Mac. Record the actual selected WebGPU backend after initialization using SPEC §3.3; `navigator.gpu`, the renderer class name, Safari or Chrome output is insufficient. A WebGL 2 fallback fails this gate.
3. Required renderer/Rapier initialization finishes before use. The normal material and small TSL cue draw correctly without GPU validation failure. A controlled initialization failure produces a readable diagnostic; document-saving infrastructure is not required here.
4. The continuous application surface reaches the top area with real macOS traffic lights, no visible identity/titlebar band and no separating rule. Native close, minimize and fullscreen work normally.
5. The window can be moved through the invisible drag region, including a natural tested activation/drag sequence from an unfocused state. Nearby controls remain clickable; canvas orbit and TransformControls manipulation are not stolen by window dragging. A visible header is not a remedy for failed hit testing.
6. Resizing, Retina/DPR handling and entering/leaving fullscreen preserve the scene and correct pointer targeting. The empty scene remains responsive at compact and default content sizes.
7. Packaged assets, including the WASM initialization path, load with Vite stopped and network disconnected. No API key, account, cloud endpoint, remote website or local server is required for core package use.
8. M0 contains no speculative subsystem beyond the native/runtime qualification and M1's immediate prerequisites.

### Required tests

Run strict type check and Tauri production build. Perform actual dev/package launch, backend/material/TransformControls, resize/DPR, native traffic-light/drag and offline-asset smoke tests, plus one controlled initialization failure. Manual repeatable checks are sufficient for this gate. Do not set up native automation, unit-test third-party camera behavior or implement persistence to make an empty-app error screen elaborate.

### Visual QA

Inspect the real Tauri development window and built `Lawsmith.app` at 1280×800 and 1600×1000 content sizes on the Mac. Verify spatial depth, node/TSL material, traffic-light clearance, invisible dragging and pointer separation. Capture the whole actual window in one screenshot or brief recording so a cropped canvas cannot conceal a titlebar band. Record console/GPU errors if any.

### Performance gate

No full numerical benchmark suite yet. Observe basic frame pacing during camera/TransformControls movement and native resizing; record unexpected startup or repeated rendering stalls and actual DPR. Do not optimize an empty scene speculatively or add compute work.

### Evidence required for review

Candidate ID, npm/Cargo resolutions and toolchain, exact Tauri prerelease family (`tauri`, `tauri-build`, `tauri-runtime`, `tauri-runtime-wry`, CLI, `@tauri-apps/api`) with WRY/macOS/WebKit identity, dev/package origin and secure-context status, actual backend and available feature diagnostics, install/type-check/build outcomes, offline package launch, native window capture and drag/control checks. Include only a short module list. SPEC §3.3 defines how the backend observation is obtained; a bare capability flag is not evidence of rendered WebGPU frames.

### Failure / rollback conditions

Block acceptance for unproven actual WKWebView/WebGPU rendering, broken packaged loading, lost native controls, a visible replacement titlebar band, stolen pointer input, premature engine use or a required runtime service. For a genuine WebGPU/runtime failure, follow SPEC §3.3's minimal reproduction and bounded investigation, normally at most two focused hours after prerequisites are ready. If unresolved, mark **M0 BLOCKED**, retain valid frontend work, record exact evidence, state whether the failure is specific to the pinned Tauri 3 prerelease and whether an earlier Tauri 3 prerelease is known to avoid it, and stop for owner replan. Do not switch to Electron, implement both shells, accept WebGL fallback, return to Tauri 2 or pin an earlier Tauri 3 prerelease without owner approval. Missing target-Mac access remains pending. Remove incidental shell scaffolding that delays M1; do not reset unrelated user work or rewrite history.

### Unlocks

M1 begins immediately in the qualified native shell and focuses on putting a manipulable law into a moving world.

## M1 — Bend the falling stream

### Objective

Create the first genuine Lawsmith interaction: bodies fall, the user drags a directional law into their path, and their trajectories bend.

### Why now

This tests the central product idea before building the editor around it. The stream and field must work before this milestone's supporting tests and evidence are expanded.

### In scope

- The exact starting recipe in SPEC §2, with at most 64 live emitted spheres and floor-only collisions for that recipe.
- One box region, one directional leaf, the normalized fade equation, and sparse evaluator-backed arrows rendered through WebGPURenderer/node materials. Prefer TSL for any custom semantic GPU cue; CPU samples suffice initially.
- A main-thread host with fixed `1/120 s` stepping, stable lifecycle/field order, immutable reset root, and a small semantic command path.
- Selection, translation, rotation, positive box resizing, enable/disable, play/pause/single-step/reset, and camera recovery.
- Proxy-based TransformControls with pointer capture/cancel and orbit suppression during a law drag.
- Ambient gravity through the common adapter, force clearing, actual mass conversion, and the documented acceleration limiter. The K=0 path suffices here.
- A compact timing/count diagnostic overlay and minimal initialization/runtime errors.

### Out of scope

Save/load, recovery storage, full author undo stack, reusable field registry, other primitive laws, expression trees, probes, timeline, recording, checkpoints, worker, advanced GPU field evaluation/simulation, raw WGSL, and brand polish. WebGPU rendering and simple TSL/node visuals are already in scope. No general body editor. A last-gesture cancel is included; historical author undo begins in M2.

### Deliverables

A playable default scene, the simple field/host/interaction modules, independent math and reset fixtures, and a continuous recording of defining-demo steps 1–9. The initial typed recipe is sufficient; do not formalize the full scene serializer yet.

### Acceptance criteria

1. After warmup, 20–100 visible bodies participate in a repeatable stream, with no unbounded body accumulation.
2. Dragging the law from its initial position into the stream visibly changes subsequent motion using spatial controls. No precision panel is required for the core action.
3. For a full-support sample, local `[12,0,0]` acceleration becomes `[0,12,0]` after a +90° Z rotation within T02 tolerance. Resizing support leaves the full-strength magnitude unchanged.
4. Outside support or with the law disabled, its contribution is zero. A previously forced body retains velocity but receives no stale field force on the next step.
5. An unconstrained body's known acceleration/velocity meets T03 tolerances, including equal acceleration at different positive masses and no double gravity.
6. Reset pauses at tick 0 and reconstructs the current authored configuration. Two runs of that fixed configuration agree exactly at ticks 600 and 1,200 under the qualified build.
7. Rendering at scripted 30/60/144 Hz cadences does not change equal-tick state. Native focus loss, minimize, application Hide and system sleep/long-gap handling pause, clear scheduling debt and require explicit Play after return; no catch-up burst occurs.
8. Dragging a handle does not also orbit the camera. Pointer cancellation releases capture and restores the last valid semantic value through the command path.
9. Arrows change with the real evaluator and fade, and the simulated field region is not derived from its rendered mesh.

### Required tests

Implement the M1 subset of T01–T05 plus the existing native-window subset of T12: box/fade, directional rotation, force lifecycle and mass, fixed-scene reset, cadence independence, disable, pointer/camera ownership and native pause/resume. Perform a real gizmo manipulation inside the Tauri app and observe an applied semantic revision; a browser harness may supplement it. Do not test only direct store mutation. Run the exact reset fixture in the qualified app runtime as well as any fast headless harness.

Use an independent collision-free constant-acceleration fixture for numerical accuracy and the live floor recipe for visual behavior. The adapter test must detect forgetting to clear persistent force.

### Visual QA

Record one continuous 45–90 second demonstration in `Lawsmith.app`: falling stream, select law, drag into stream, rotate, resize, disable/enable, and reset/repeat a fixed configuration. The camera must show both the support boundary and resulting paths. Verify that leaving a volume does not visibly erase sideways velocity. Check selection through a translucent face, camera recovery and the native window-drag region without stealing a law drag. Confirm minimize/Hide/app-switch and sleep/resume behavior separately.

### Performance gate

Measure P0 in the packaged app under SPEC §18: three 60-second focused-window captures after warmup, with step p95 ≤2 ms, edit-to-frame-submission p95 ≤50 ms, callback interval p95 ≤20 ms/p99 ≤34 ms, and simulated/wall time ≥0.98 at 1×. Preserve the raw per-run results. Other runtimes can supply preliminary results; required owner-Mac application evidence remains pending until obtained.

### Evidence required for review

Candidate/base IDs, numerical fixtures, exact reset comparisons, cadence test outcomes, P0 measurements, and the continuous interaction recording. State explicitly: **interactive proof complete; portable full demonstration awaits M2**.

### Failure / rollback conditions

Block if a slider or direct engine mutation substitutes for spatial manipulation, force accumulates across ticks, render cadence changes physics, or repeated reset differs. Remove unneeded polish rather than weakening the semantic checks. If performance fails, diagnose P0 before considering a worker or advanced GPU compute; keep the modern renderer. Retain the last working one-law candidate.

### Unlocks

An actual product to play with, a small authoritative host, and a credible basis for portable scene authoring.

## M2 — Portable scenes and recoverable authoring

### Objective

Complete the ten-step defining demonstration: save the law configuration, reopen it, obtain the same behavior, and recover from experimental edits.

### Why now

The interaction has earned a document model. Formalizing it now protects the growing system without making serialization the first-night project.

### In scope

- SPEC §5/§15 scene schema, canonical serialization, explicit units/seeds/IDs/profile, and semantic/presentation separation.
- Native Open Scene, Save Scene and Save Scene As through the official Tauri dialog plugin from the Tauri 3 line, its exact version resolved against the pinned Tauri family and qualified before acceptance, and a narrow native document-I/O helper; known-capability validation, bounds, format discriminator and deterministic constructors.
- A tested migration mechanism only as needed for an actual prior schema; no fictional migration collection.
- Undo/redo for law edits, duplication/deletion, and gestures grouped into one author transaction.
- Laws list, contextual precision controls, acknowledged-revision save/dirty state, and transactional application-local recovery with one previous valid snapshot.
- Session-local native destination binding, atomic file replacement, bounded UTF-8 reads, failed/canceled-operation reporting and shared close/Quit/new-open unsaved-work guard.
- Explicit reset semantics for body/emitter-definition changes; a broad body authoring UI is not required.

### Out of scope

Saving arbitrary live engine state inside a scene file, playback recording, checkpoints, cloud sync, remote assets, scene marketplace, general scripting and extra laws. No general filesystem bridge, native document model, recent-document system, persistent path authority, watcher, database or parallel IndexedDB recovery. Do not package opaque engine bytes as the scene's primary representation.

### Deliverables

A portable `.lawsmith.json` file saved by the native app, frontend schema/validation and canonical serializer, thin document-I/O helper, application-local recovery, close/save guard, author undo/redo and the complete defining-demo recording. Include the default recipe as an editable bundled scene.

### Acceptance criteria

1. Save → fresh application launch → import preserves semantic values, IDs, ordering, seed, profile, law pose/support, and initial conditions; canonical re-export is idempotent.
2. The imported fixed scene reaches the same equal-tick state as the original under the same qualified environment.
3. Complete all ten defining-demo steps inside the native app, including a file saved to a user-chosen location through the real macOS dialog and reopened after fresh app launch. Browser download UX or a mock serializer is insufficient.
4. Changing only camera, color, label, or arrow visibility leaves the semantic digest and simulation unchanged. Disabling a law changes semantics.
5. One drag produces one undo entry; undo/redo restores the authored law values. Undo during live motion does not pretend to rewind bodies.
6. Invalid or out-of-range dimensions/motion/settings, nonfinite numbers, zero quaternions, duplicate IDs, malformed arrays, oversized files, and unknown capabilities are rejected before replacing active work. A negative acceleration limit or float-overflowing finite dimension cannot enter the runtime.
7. Disk/permission/recovery failure leaves in-memory editing and Save As to another writable location usable. Acknowledgment identifies the revision actually stored; later edits stay dirty. Explicit file workflows are serialized, so overlapping Save As requests cannot reorder destination binding. Canceled or failed Save As retains the prior binding; failed replacement preserves the existing file.
8. Loading starts paused at tick 0. The interface explains through its controls that Save Scene stores the setup, not a resume point.
9. Recovery validates current/previous snapshots, rejects stale queued generations/revisions and never overwrites a user file automatically. Successful Save retires recovery eligibility only through its captured revision; a later dirty revision remains eligible. Accepted Discard retires both written and queued snapshots for that generation. Neither saved nor discarded work is offered as unsaved after restart. A recovered document re-establishes its destination through a native dialog; imported or persisted strings cannot grant path authority.
10. Native close/Command+W, app Quit/Command+Q and new/open replacement use the same Save/Discard/Cancel guard. Pause/settle and freeze edits during that guard, coalesce Close/Quit, and re-evaluate dirty state after any pending save. Retain accepted data until the full guard commits; failed/canceled saving keeps work open, and a canceled Discard does not retire recovery. File dialogs cause no catch-up ticks.

### Required tests

T06 plus the M1 regression subset and relevant T12 desktop-file checks. Add canonical quaternion/save idempotence fixtures, duplication/undo identity tests and a real native save/relaunch/open test. In disposable files and a separate test recovery directory, exercise invalid import, native dialog cancel, denied/disk-full write, interrupted replacement, stale save acknowledgment, overlapping Save As requests, recovery corruption, restart after Save/Discard, and close/Quit/new-open during a pending or failed save. Verify that a later accepted edit cannot be lost when an earlier save completes; guard freezing and latest-revision checks must cover that case. A browser mock proves only the frontend boundary. Settling a pending drag captures the accepted law, not an unacknowledged preview.

### Visual QA

Repeat the full demonstration from a fresh native app launch with isolated recovery state. Inspect the saved scene after native reopening, undo/redo a translation/deletion, cancel Save As and trigger a harmless invalid import. The old scene remains visible. At 1280×800 content size, save/reset/play and the selected law remain reachable; no full-width header is introduced to hold the file actions.

### Performance gate

P0 continues to meet its gate in the packaged app. On P0-sized files at a local writable location, open including candidate-world initialization and explicit save each complete within 500 ms after the modules are initialized; measure separately from human time in the native dialog. Recovery must not cause a greater-than-50-ms frontend main-thread stall during an ordinary gesture commit. Report timing evidence if the target is missed rather than inserting hidden async loss of edits.

### Evidence required for review

Immutable candidate and diff from M1, exported sample file, semantic round-trip/determinism results, failure/recovery tests, P0/import/export timings, and complete demo recording. **Independent review gate:** verify state ownership and format semantics, not merely the UI.

### Failure / rollback conditions

Block for a scene that reloads with changed physics, lost unsupported laws, accumulated save-rounding drift, undo that corrupts identity, or failed import that destroys active work. Keep the prior stable scene/recovery record and revert the faulty persistence transaction. No acceptance until all ten demonstration steps are evidenced.

### Unlocks

Portable V0, useful shareable experiments, and safe iteration on the law vocabulary.

## M3 — A small tactile law vocabulary

### Objective

Let the user experiment with directional acceleration, soft radial attraction/repulsion, vortex, and drag through a common law abstraction.

### Why now

One law proves manipulation. A few genuinely different effects create the “what happens if I put this inside that?” loop and test whether the abstraction extends cleanly.

### In scope

- Internal primitive registry and pure compiled CPU evaluator returning `(A,K)`.
- Exact primitive equations from SPEC §6, stable aggregate drag adapter from §9, and same-state additive overlap.
- Sphere and Y-cylinder regions in addition to box; shape-correct extent handles.
- Strength handle, radial/vortex core handle, and boundary-fade handle, with precise numeric equivalents.
- Creation, duplication, enabling, deleting and selecting multiple distinct law objects.
- One all-body collision scene and examples for radial pull, swirl and drag.
- Capability-aware serialization for new primitives/regions, preserving the M2 format contract.

### Out of scope

Inverse-square gravity, angular/torsional fields, moving drag media, impulse/pulse channel, noise, expression operators, arbitrary body meshes, fluids, and general physics-engine features. Do not replace the selected soft-radial equation with a more “physical” one under the same kind.

### Deliverables

Four primitive descriptors/evaluators, three region kinds, spatial parameter handles, finite-core tests, stable drag tests, and a small scene demonstrating each primitive plus at least one useful overlap.

### Acceptance criteria

1. Each primitive matches T02 numerical fixtures with finite output at its center/axis; disabled primitives return zero.
2. Overlapping drag rates add before integration. Pure drag never increases speed and never reverses velocity beyond the engine's f32 resolution (SPEC §9.1), including high supported coefficients and active limiting. It matches the specified exponential free-space update when the acceleration limiter is inactive; capped cases match the documented limited update instead.
3. Ambient gravity, drive and drag are combined once; built-in engine gravity/damping are not applied a second time.
4. Translating/rotating laws changes their documented support/frame behavior. Resizing each region changes only its dimensions, with no sphere deformation or cylinder elliptical cross-section.
5. A user changes strength and fade through spatial handles, not exclusively through inspector sliders. Each accepted value survives export/reload and undo.
6. Rotating a drag region rotates its support without inventing a direction for isotropic drag. Moving it does not impart the volume's velocity to bodies.
7. Adding a primitive does not require a change to host stepping, replay placeholders, or serializer orchestration beyond the registry/schema capability entry.
8. In the collision example, fields affect the sampled centers and contacts remain Rapier-owned; field volumes are not hidden colliders.

### Required tests

Complete T01–T03 for all supported shapes/primitives; include overlapping drag, tiny positive Kh, opposite drives, force clearing after removal, and contribution/limiter algebra. Run T05/T06 for new handles and formats, and T04 reset tests with seeded multi-law scenes. Test narrow/fast center sampling as a documented limitation, not as a falsely successful continuous-crossing solver.

### Visual QA

Record radial capture/release, vortex direction reversal, a drag pocket, and a two-law overlap. For each, use at least one spatial parameter handle. Check a cylinder's axis against swirl direction and its rendered/support dimensions. Demonstrate a body contacting another body and explain why its velocity change can differ from the law arrow.

### Performance gate

P0 remains within its gate. Characterize P1 without probes using the declared 200 bodies/16 one-leaf laws; meet step p95 ≤3 ms/p99 ≤5 ms and edit latency p95 ≤50 ms. Broader frame/resource qualification is completed in M9, but obvious unresponsiveness is a blocker now. Do not solve a field-kernel regression by reducing the fixture's entity count.

### Evidence required for review

Equations-to-fixture results, source boundaries/registry change, exported multi-law scenes, reset comparisons, handle recordings, and P1 kernel/input measurements. A bounded independent math review is encouraged if the adapter implementation required numerical changes.

### Failure / rollback conditions

Block for singular centers, anti-damping, order-dependent sequential application, scaled strengths during resizing, mismatched support geometry, or a new primitive that bypasses the host. Remove the broken addition and retain M2/M1 scenes intact. Changing the law equation requires a reviewed semantic version change rather than silently changing saved behavior.

### Unlocks

A useful creative vocabulary and a stable shared kernel for richer explanations and compound laws.

## M4 — See why motion changes

### Objective

Make experiments legible through selected-body contributions, faithful trails, and a modest population of lightweight field probes.

### Why now

Multiple laws create effects that a single direction arrow cannot explain. Explanation must improve alongside complexity, before introducing compound expressions and alternate futures.

### In scope

- Selected-body center/velocity readout, per-law external acceleration and shared-beta/limiter contribution totals.
- Separate velocity arrows and external-acceleration arrows, with sample tick and units.
- Fixed-tick recorded body trails, bounded buffers, and clear reset behavior.
- CPU collision-free inertial probes with a separate PRNG and state arrays, using the shared field kernel and specified probe integrator; WebGPURenderer/TSL handles their display.
- Visual-only “show this law's arrows” filtering without changing active physics.
- Contact indication and a clear distinction between drive samples, drag, applied law acceleration, and solver contact effects.

### Out of scope

Dense volume rendering, GPU probes, streamlines presented as trajectories, future prediction, baseline ghosts, field slices, heatmap machinery without a demonstrated use, and photorealistic effects.

### Deliverables

A contribution inspector, honest vector legends, trace/probe subsystem with bounded resource accounting, a meaningful explanation scene, and numeric-to-visual verification fixtures.

### Acceptance criteria

1. CPU spatial samples agree with the authoritative compiled evaluator under T08; no independently guessed arrow direction is used.
2. At a selected body's retained transition sample, displayed per-law applied contributions plus ambient gravity sum to submitted `force/mass` within T03 tolerance, including active limiting. The observation identifies from/to tick and sampled center/velocity; a paused next-step preview cannot rewrite the last-applied explanation.
3. A drag field at a spatial point displays its coefficient/drive semantics or declares its probe velocity; it never invents a nonzero resting drag arrow.
4. Selected-body explanation is labeled external law acceleration, with velocity and contacts separately identifiable. Removing a drag is not described as subtracting its displayed contribution from an otherwise unchanged future.
5. Stored trail positions match actual body observations at every fourth tick. Trails clear/rebuild consistently on reset and scene load.
6. Probe count, visibility, random seed, and visualization-only filtering cannot alter any authoritative rigid-body state or emitter PRNG progression.
7. With default limits, the selected law, its support and at least one affected body remain legible at 1280×800; users can turn off probes/trails without disabling laws.

### Required tests

T08, relevant T03 arithmetic checks, reset/render-state invariance from T04, and allocation/count bounds from T11. Include contact-rich, zero-velocity drag, overlapping-drag, and limiter-active fixtures. Compare trail sample coordinates to observed state, not screenshot pixels alone.

### Visual QA

Record one body entering/exiting a drag pocket, another interacting with overlapping laws, and a collision. Show the sampled contribution readout alongside the motion. Verify acceleration and velocity distinguishability, saturation marks on capped arrows, and reasonable default density. Inspect without relying on color alone.

### Performance gate

P2 uses 100 bodies/four laws/2,000 probes without exceeding the SPEC §18 frame and edit-latency targets. Default trace/probe buffers stay under 32 MiB. P0 cannot regress when all additional visualizations are off. If probes are the bottleneck, optimize/cap their documented workload; do not move rigid bodies to the GPU.

### Evidence required for review

Numeric sample/contribution/trail comparisons, P2 per-run timings, buffer accounting, a visual explanation recording, and equal-tick authority comparisons with visual features toggled.

### Failure / rollback conditions

Block if a visualization lies about its quantity, probes consume simulation randomness, trail buffers grow without bounds, or selected-body data mixes incompatible sampled states. Disable the faulty optional overlay while fixing it; maintain the M3 authoring path.

### Unlocks

A visual debugging language that can explain compound laws and later compare futures.

## M5 — Compose a law you can hold

### Objective

Create one compound, spatially manipulable law from a few primitive ingredients, with inspectable masking/gain and deterministic modulation.

### Why now

The vocabulary and explanations are stable. Composition can now add creative power without becoming a generic visual-programming application.

### In scope

- Bounded `sum`, nonnegative `gain`, and `mask` nodes exactly as in SPEC §6.
- Constant and triangle tick-based gain, including explicit period/phase and no wall-clock dependence.
- A compact ingredient list inside the selected law; add/remove terms, edit gains, inspect child contributions and mask support.
- One common field frame and outer support; explicit local mask pose semantics.
- Serializable, validated AST with depth/node/leaf limits and capability negotiation.
- A “Storm Bottle” recipe combining radial pull, vortex and drag, manipulated as one object.

### Out of scope

Node canvas, arbitrary transform nodes, field references, cycles, arbitrary grouping/merging of separately transformed laws, priority stacks, conditional activation, signed general gain, scripting, plugin API, and GPU compiler. Tree data does not authorize a general DSL runtime.

### Deliverables

A bounded expression evaluator/compiler, schema/operator validation, ingredient editor, contribution inspection, deterministic triangle modulation, and an editable compound-law example.

### Acceptance criteria

1. Sum/gain/mask fixtures satisfy T07, including multiplying both A and K and preserving the stored evaluation order.
2. A nested mask affects only support in its documented local frame; it does not silently rotate the child vector field.
3. Negative gain, invalid phase/period, excessive depth/nodes/leaves, and unknown operators are rejected before changing active work.
4. Triangle gain reaches its defined values at known ticks; pause holds the same value and seek-ready evaluation depends only on tick and parameters.
5. The Storm Bottle moves/rotates/resizes as one law while its equation and support remain explainable. Resizing does not alter primitive strength/core parameters.
6. Export/reload and fixed-scene reset preserve the full expression and resulting equal-tick behavior.
7. Removing an ingredient, setting its constant gain to zero, or disabling its containing law eliminates the corresponding contribution; undo restores the prior expression. No separate ingredient-enabled semantic flag is implied. UI order is not treated as priority. Tests distinguish authored AST order from cosmetic Laws-list order.
8. The existing one-leaf path remains small and functional; M1 scenes do not require a graph migration just to run.

### Required tests

Complete T07, expand T06 for expressions/capabilities, T08 for compound contributions, and T04 for modulation/reset. Include analytically computed two-drive sums, two-drag sums, nested masks, gain-zero behavior, and a quaternion-transformed outer law.

### Visual QA

Record constructing the compound from primitives, moving the bottle into a stream, removing and undoing one ingredient, adjusting a mask, and enabling triangle gain. Show what each ingredient contributes. The workflow must fit a contextual list; a graph editor or deep modal navigation is a scope failure.

### Performance gate

Maintain P0/P1/P2 gates. Characterize a named compound fixture with 100 bodies and eight laws of four primitive leaves each, and meet active-step p95 ≤3 ms and edit latency p95 ≤50 ms. Cache compilation on edits; no tree validation or schema parsing in the per-body hot loop.

### Evidence required for review

Immutable candidate, AST/schema/equation fixtures, compound scene export, contribution checks, performance capture, and construction/manipulation recording. **Independent review gate:** math, serialization, and whether the feature still feels like manipulating a law.

### Failure / rollback conditions

Block for changed primitive meanings, unchecked negative drag, mismatched mask frames, broken file compatibility, or a general-purpose programming UI replacing the intended instrument. Retain primitive-only scenes and remove unapproved operators rather than broadening the project to accommodate them.

### Unlocks

A deeper creative core and an explicit computational representation ready to record and replay.

## M6A — Record + Exact Replay

### Objective

Record the resolved interventions a user actually made and reproduce the exact final authoritative state by replaying from the frozen tick-zero root in the qualified Lawsmith runtime. Establish a trusted linear reference before adding checkpoints.

### Why now

The law semantics are rich enough to preserve interesting experiments. Root, applied-command and boundary correctness can be proved independently of restoration, caches and arbitrary time navigation. A recorded intervention that replays exactly is already a useful product capability.

### In scope

- Immutable `RunRecord` with a new frozen tick-zero root, ordered applied semantic commands, simulation fingerprint, qualified application/runtime identity and frozen final `(tick,cursor)`.
- Exact resolved payloads, same-tick ordering, multi-boundary drag samples and undo as later commands; the original root/log never aliases editable state.
- Existing duration/count/complete-UTF-8-byte limits, endpoint/header reservation, preflight rejection and intact stop/final-address behavior.
- Native `.lawsmith-run.json` open/save/validation through M2's I/O helper; clear scene-versus-recording save and close behavior.
- Straightforward forward replay from the root, with Play/Pause, forward single-step, Replay from Start, read-only progress and Return to authoring.
- One retained paused authoring world/context and one disposable root-built replay world in steady replay, owned by one coordinator. A serialized import may temporarily hold one additional unstepped candidate. Mode-specific observations preserve the main draft, undo and recovery.

### Out of scope

Runtime checkpoint capture/restore, `World.restoreSnapshot`, checkpoint sidecar/cache, nearest-checkpoint selection, arbitrary seek/scrubbing, seek progress/cancellation, corrupt-cache recovery, branching, mid-run roots, editable historical commands, reverse integration, cloud archives, downloading old engines and perpetual recordings. A test may observe engine snapshot bytes for equality; it must not restore them or make M6A depend on M6B infrastructure.

### Deliverables

A recorder and root-built linear replayer, immutable run file format, bounded recording controls, exact state-comparison fixtures, native run save/open, and a real recorded intervention that reproduces without manual input. The qualified app/runtime identity accompanies the evidence.

### Acceptance criteria

1. Record a multi-boundary drag, enable change, triangle gain and live undo; stop; replay from the frozen root; reach exactly the same authoritative final state at the same `(tick,cursor)` in the qualified app environment, without checkpoint restoration.
2. A drag remains one author-undo entry while retaining every consumed replay sample. Neither undo nor subsequent edits mutate the root or consumed log prefix.
3. Paused same-tick edits apply once in sequence. Replay consumes included commands at the final tick and then stops without another physics step. A zero-duration recording containing several tick-zero commands reproduces with zero completed steps.
4. Recording stop freezes the final cursor even if another unrecorded edit follows at the same tick. The stopped record is unchanged by that edit or by later reset/authoring.
5. Replay reconstructs all root laws, including untouched laws, for the viewport/inspector. The newer authored scene, author undo, recovery revision and paused live body/emitter state remain unchanged. Return to authoring reattaches that context, clears scheduling debt and stays paused; it does not reconstruct from current scene initial conditions.
6. Native run save → application restart → native open → root replay reaches the same final state in the same qualified environment. Unsupported schema, profile, runtime identity or malformed commands cannot overwrite current work or receive an exact-success label.
7. The recorder stops intact at 60 simulated seconds, 50,000 commands or the complete 16 MiB serialized budget. It preflights commands before mutation, reserves endpoint/header growth and ends a capped gesture at its last acknowledgment. Unaccepted queued edits do not spill into the stopped record or paused scene; the saved record reimports within the same limits.
8. Camera, visualization choices and scripted rendering cadence do not alter equal-address replay; pause advances no ticks or triangle phase. The native background/resume policy continues to hold.
9. Replay ends read-only at its frozen final address. Ordinary Save Scene is disabled there; Save Recording targets the immutable record. A close/replacement guard explicitly names and may save the retained main authored scene, preserving the selected paused context if any later item is canceled. Every operation that would drop an unexported record protects it first. Controls distinguish Reset Scene, Replay from Start and Return to authoring; no interactive seek control is presented yet.
10. Repeated replay/start/return releases disposable worlds and rendering resources. Steady replay holds at most one authoring context and one replay context; only the selected context advances under the single coordinator. A serialized import may temporarily add exactly one unstepped candidate world, with a peak of three. Failure/cancellation frees it without replacing existing contexts; successful commit promotes it and disposes displaced worlds to restore the appropriate steady-state count.

### Required tests

T09 plus applicable T04/T06/T11 cases; no T10 checkpoint/seek cases are prerequisites. Compare canonical future-affecting state and observational engine snapshot bytes where available, without restoring those bytes. Report first divergence by tick/entity/component. Run the determinism checks inside the actual qualified app, not only a Node/browser harness.

Include final-tick commands, a zero-duration record, multi-boundary drag/undo, mismatched identity import, a count/byte cap halfway through a queued gesture, run-file restart/open, and return-to-authoring invariance. Import valid/invalid files from replay and check transient candidate disposal. Exercise close/replacement guards with both a dirty main scene and unexported recording: cancel a later item after an earlier Save or staged Discard, verify explicit retained-source saving, and retain the selected paused context and recording. Record two paused edits, stop, then make a third unrecorded edit at the same tick; replay includes exactly the first two. Verify that production replay never invokes snapshot restoration or checkpoint selection. Exact equality has no drift allowance.

### Visual QA

Inside `Lawsmith.app`, record a real intervention, stop, save the run, replay it from the root without manual input, and show the equal final tick/cursor. Make a later authoring edit and verify replay still displays the recorded laws; Return to authoring restores the later paused context. Inspect the simple playback/progress controls with someone who did not implement them. Do not demonstrate scrubbing or checkpoint navigation as if M6B were already present.

### Performance gate

P1/P2 live interaction remains within budget in the packaged app. Normal paced replay remains responsive; a large same-tick command group may yield between commands without advancing physics or claiming a partially applied endpoint complete. No instant full-run or arbitrary-seek latency target applies. Repeat 20 replay/return and replay-restart cycles, including successful/failed/canceled imports, and show the bounded steady-state and transient world counts above. After Return to authoring, the disposable replay world is freed. Recording bounds are enforced without a synchronous unbounded serialization operation on every pointer sample.

### Evidence required for review

Candidate, native-saved run fixture, exact equal-address results and first-divergence diagnostics, final-tick/zero-duration/cap/return-context tests, application/runtime identity, resource-cycle results and a real recording/linear-replay video. Identify the checkpoint-free path that will serve as M6B's oracle.

### Failure / rollback conditions

Block if the log retains only the last transform of a drag, a root aliases editor state, terminal commands are omitted, return-to-authoring loses live context, recording limits discard history, or exact replay is claimed for an unqualified runtime. Retain accepted M5 scene authoring; repair recording/linear replay without adding checkpoints to conceal its error or relaxing equality.

### Unlocks

A useful reproducible experiment and a trusted uninterrupted root-and-log reference for M6B.

## M6B — Checkpoints + Seek

### Objective

Restore a complete checkpoint and replay forward to an arbitrary supported recorded address, producing exactly the state reached by accepted uninterrupted M6A replay.

### Why now

M6A has already proved recording, root construction, command ordering and linear replay. Checkpoint/seek failures can now be isolated against that working oracle. M7 must wait for this complete-state gate.

### In scope

- Complete Rapier world snapshot plus Lawsmith sidecar under SPEC §14.1, captured atomically at `settled-before-lifecycle`.
- Emitter PRNG/schedules/ordinals/counts, body/collider identity mappings, lifetimes, active laws/ambient acceleration and all other future-affecting host state.
- Record/live-context/prefix identity, qualified runtime compatibility and exact `(tick,cursor)` checkpoint address.
- Checkpoints every 240 ticks, bounded individual/cache size, compatible nearest-checkpoint selection and eviction.
- Forward reconstruction, arbitrary supported seek, a seekable recording timeline, yielding batches, progress, cancellation and latest-request-wins.
- New-world restoration, stale-wrapper disposal, mode/context isolation and corrupt-compatible-cache reconstruction from the accepted root/log.
- A retained checkpoint-disabled M6A replay path for independent equivalence checks.

### Out of scope

Changing accepted M6A run semantics, engine/profile upgrades to make a test pass, checkpoint-only replay, reverse integration, branch UI, branch DAG, portable checkpoint roots, alternate-run export, cloud archives or cross-runtime snapshot portability. No requirement to persist checkpoint caches across application restart.

### Deliverables

A complete checkpoint representation, bounded in-memory cache, seek/reconstruction controls, cancellation/progress behavior, exact comparisons against M6A and a reviewed complete-state boundary ready for M7.

### Acceptance criteria

1. For selected `(tick,cursor)` addresses, checkpoint restoration plus forward replay matches uninterrupted checkpoint-disabled M6A replay exactly in the qualified app runtime, including contacts, emissions, deaths and field edits.
2. Targets between checkpoint intervals work. Birth/death boundaries and multiple paused revisions process exactly once according to the settled-before-lifecycle phase; final-boundary and zero-duration records remain correct.
3. A later cursor at the same tick cannot serve an earlier target. A newer unrecorded live checkpoint cannot serve a stopped recording; keys and eligibility include record/prefix/context and qualified runtime identity.
4. Restoring creates a new world and rebuilds its wrappers/maps. Old wrappers from the replaced world cannot survive, while the separately retained authoring context remains intact. No position/velocity-only reconstruction is accepted.
5. Superseded seek results never overwrite a newer target, another replay context or Return to authoring. Only the latest fully reconstructed target becomes visible as that requested state; progress is explicit while work is incomplete.
6. A corrupt compatible cache is discarded and reconstructed through M6A's root/log path. An incompatible runtime/profile is not repaired by silently changing numerical semantics or labeled an exact success.
7. Checkpoint cache is at most 64 MiB and an individual checkpoint at most 16 MiB. Eviction cannot alter root/log; repeated restore/seek disposes abandoned worlds and buffers.
8. Cached seek in a supported 60-second recording meets p95 ≤250 ms. Uncached work yields at approximately 8 ms batches and exposes progress/cancel after 100 ms. Trails rebuild or clear explicitly; they never masquerade as data from the target time.
9. Read-only replay and Save Scene/Return to authoring ownership from M6A remain unchanged. Seeking cannot mutate the main draft, undo or application-local recovery.

### Required tests

T10 checkpoint/seek cases and relevant T11 resources, plus T09/T04/T06 regressions. Reuse accepted M6A fixtures and compare each target with its uninterrupted result. Include contacts, emitter births/deaths, multiple same-tick edits, final-tick edits, no-cache reconstruction and a zero-duration recording. Test wrong-prefix/later-cursor selection, injected cache corruption, stale wrappers and rapid superseded seeks followed by Return to authoring. Native app interaction evidence is required; browser harness cancellation tests may supplement it.

### Visual QA

In `Lawsmith.app`, replay an accepted M6A run, seek before an intervention, seek forward to its result, rapidly change targets and cancel a longer reconstruction. Show requested tick/cursor and final state clearly. Return to authoring while work is pending and verify that no late result replaces the retained context. Inspect trail reset/rebuild and progress labels.

### Performance gate

Meet the cached/uncached targets and byte limits above in the packaged app. P1/P2 live interaction remains within its existing budget. Repeat 20 seek/reset cycles and show bounded worlds/cache bytes. Measure reconstruction separately from deliberate pauses and UI animation; no relaxed equality threshold accompanies faster seeking.

### Evidence required for review

Immutable candidate and accepted M6A base, complete sidecar/phase audit, exact restored-versus-linear comparisons, same-tick/prefix/runtime/corruption/cancellation cases, resource/timing records and native seek video. **Independent complete-state review is strongly recommended before accepting M6B and beginning M7.** Review the trusted linear oracle and restored result separately; avoid a common faulty checkpoint helper on both sides of the comparison.

### Failure / rollback conditions

Block for incomplete sidecars, wrong boundary/cursor selection, stale wrappers, late commits, cache corruption that destroys root/log, or a result unequal to accepted M6A replay. Keep M6A recording/linear replay accepted and usable while repairing M6B. Do not alter the original recording or weaken exactness to make restoration match. M7 remains locked.

### Unlocks

Trustworthy complete-state seeking and the accepted foundation for M7's shared-fork futures.

## M7 — Preserve a future, change a law

### Objective

From one paused world, preserve a computed baseline, change one law, and see two synchronized futures.

### Why now

The feature depends on accepted M6B complete-state capture/restoration, already checked against M6A's uninterrupted replay. Implementing it before that gate would risk comparing unrelated states and mislabeling the result.

### In scope

- One shared fork checkpoint, one immutable baseline A, and one editable alternate B.
- Controlled continuation semantics: both start with laws as of T, keep deterministic automatic schedules, and omit prerecorded post-T human commands from both.
- A real baseline calculation for 600 ticks initially, yielding and cancelable, with actual paths/state samples.
- Baseline ghosts or path ribbons synchronized by tick and stable body identity; distinct non-color styling.
- Session-local alternate interventions, no-op comparison, bounded horizon extension, Replay Alternate with its retained suffix, and New Alternate that deliberately clears interventions.
- Preserve the source recording and its existing tail unchanged.

### Out of scope

Branch DAG, more than one editable alternate at once, arbitrary future command editing, speculative extrapolation presented as simulation, ghost collisions, split-screen requirement, portable alternate-run/checkpoint-root export, and exporting checkpoints as ordinary scene initial conditions. Export Alternate Setup may create a normal scene; it does not promise to resume the comparison.

### Deliverables

A “Compare from here” workflow, immutable fork/baseline handling, baseline trace cache, alternate command record, comparison controls, and a Two Futures example with a known intervention.

### Acceptance criteria

1. Before the new intervention, A and B have exactly equal authoritative state at the same settled tick/cursor, excluding branch labels.
2. A no-op alternate remains exactly equal to A through the full 600-tick horizon, including body IDs, lifecycles and automatic modulation.
3. In a collision-free fixture, a known directional-law edit gives a specified measurable divergence; the scene fixture must set and document a threshold of at least 0.5 m separation within the horizon without hitting the acceleration limiter.
4. Ghost positions are drawn from A's computed state at the displayed tick. B never receives ghost colliders, forces or events.
5. Editing B, Replay Alternate or New Alternate cannot mutate A, the fork, source recording/tail, or main authored document. Replay Alternate reproduces retained interventions; New Alternate clears them. Baseline hashes remain unchanged.
6. If the fork is in a recording's past, neither A nor B silently inherits later human edits; their automatic emitters and tick modulation remain aligned.
7. Body comparison uses stable IDs. Missing bodies due to lifecycle/capacity differences are marked absent, not matched by array index.
8. Reaching the precomputed horizon pauses or explicitly extends it; there are no invented baseline frames. An extension that exceeds the accounted comparison-memory budget is refused or offered with a shorter explicit horizon. A superseded baseline request cannot replace a newer comparison.

### Required tests

Complete T10 branching cases, including exact no-op branches, alternate intervention, immutability, source-tail preservation, same-tick edit ordering, missing-body handling, cancellation, and ghost nonparticipation. Reuse M6A's T09 authoritative observations and M6B's accepted complete-state fixtures. Test at a fork with active contacts and after emitter deaths, not only in empty free space.

### Visual QA

Record pause at T, baseline creation, one law edit, and both actual futures. Freeze at a common tick and show baseline/alternate identity and separation. Turn ghosts on/off without changing B. Use Replay Alternate to reproduce the same edited future, then separately demonstrate New Alternate clearing interventions. At overlapping positions, both branches remain identifiable through stroke/opacity/label differences.

### Performance gate

P3 computes the 600-tick baseline in ≤3 seconds on the declared owner environment, with yielding batches and responsive cancel. Follow SPEC §18's separate warmup/full-horizon setup for its 60-second active-playback capture. Active alternate edit-to-frame-submission latency p95 ≤50 ms and supported frame targets remain met. Comparison caches stay ≤64 MiB, including fork, baseline endpoint checkpoint, samples and indexes; memory refusal is explicit.

### Evidence required for review

Immutable candidate, exact fork/no-op comparisons, complete local fork checkpoint and intervention suffix, baseline samples/hashes, source run artifact when one exists, documented divergence fixture, ghost-isolation and memory-limit tests, P3 timings/memory and the full comparison recording. No portable alternate-run export is required for an unrecorded live fork. **Independent review gate:** confirm these are two continuations of the same state, not visually similar unrelated simulations.

### Failure / rollback conditions

Block for position/velocity-only cloning, changed emitter randomness, baseline mutation, asymmetric inherited command tails, unsynchronized ticks, or hypothetical paths labeled as computed alternatives. Keep M6A recording/linear replay and accepted M6B seeking usable; remove comparison from accepted status until complete-state correctness is demonstrated.

### Unlocks

Lawsmith's flagship systems capability: controlled, explainable changes to a future.

## M8 — Make it an inviting creative instrument

### Objective

Integrate the proven capabilities into a memorable, recoverable and accessible authoring experience that encourages continued experimentation.

### Why now

The central systems exist. This milestone refines their relationships and default presentation; it does not postpone basic usability that earlier milestones already require.

### In scope

- Coherent full-window application surface, contextual Laws list/inspector, improved handles, camera recovery and clear playback/history/comparison states; native traffic lights and invisible dragging remain intact.
- The five example scenes in SPEC §19, editable from opening, with useful camera framing and a one-line invitation.
- Visual hierarchy, restrained translucency, readable vectors/trails, selection through overlaps, and consistent units/labels.
- Keyboard/DOM equivalents, normal macOS text editing, visible focus, a small 100–200% Interface Scale control with reflow, non-color identity cues and reduced decorative motion.
- Recovery messaging, empty/error states and discoverable undo/reset.
- First-use and owner exploratory QA of the actual product.

### Out of scope

New simulation domains, a new programming language, new field primitives to compensate for poor examples, redesign into a generic 3D editor, multiplayer, account setup, onboarding questionnaire, website deployment, photorealistic graphics, settings framework or new native integrations. No visible replacement titlebar, fixed full-width divider or mandatory permanent Lawsmith/Build/Simulate/Explore header.

### Deliverables

A cohesive interface, five bundled editable scenes, keyboard/control reference, corrected usability issues, and actual product screenshots suitable for later documentation.

### Acceptance criteria

1. From each bundled example, the user can make its intended meaningful change in at most three obvious actions without consulting developer documentation. Record the action sequence.
2. The default Sideways Rain interaction still works directly in the viewport; no new panel or modal is required to drag/rotate its law.
3. A keyboard user can select a law, change position/rotation/extent/strength, enable it, play/pause/step/reset, undo, and save/open through labeled controls and native dialogs.
4. At 1280×800 content size and 200% Interface Scale inside `Lawsmith.app`, primary actions remain reachable through reflow/scrolling. Text controls preserve normal macOS typing/editing behavior and focus remains visible. Scaling does not change simulation or silently change renderer quality.
5. Support boundaries, actual law directions, field identity, enabled state, and baseline/alternate identity are distinguishable without color alone.
6. User-reduced decorative motion disables camera easing/decorative effects; the user can pause content motion before interacting with a loaded example.
7. Scene, recording and comparison actions remain semantically clear; no button implies that ordinary Undo changes an already computed past.
8. At least one owner or independent tester completes a short exploration with no blocker to selecting, changing, resetting and saving a law. Record concrete confusion and resolution; “looks polished” is not an acceptance result.
9. The whole window reads as one continuous application surface, with local breathing room around native traffic lights. Product identity/navigation may move, collapse, scroll or disappear by context; no permanent full-width titlebar band or separator is introduced. Invisible window dragging works without stealing buttons, inspector controls, canvas or gizmo input at supported scales.

### Required tests

T05/T12 keyboard/focus/error-flow checks and targeted regression tests for corrected functional issues. Reuse T06/T09/T10 to ensure polish does not alter scene/replay/branch semantics. Do not add tests for every decorative style declaration.

### Visual QA

Inspect all five examples in `Lawsmith.app` at standard/compact content sizes and 100%, 150% and 200% Interface Scale, with a bright enough display to judge contrast. Check the entire window surface, native traffic lights/drag regions, overlapping translucent laws, near-zero/saturated arrows, long labels, collapsed panels and comparison controls. Record the three-action workflows and one end-to-end keyboard/native-file session. Browser zoom or cropped canvas captures do not replace these checks.

### Performance gate

P0/P1/P2/P3 retain their relevant targets with the final default visual settings. Decorative effects that cause a supported workload to fail must be reduced or removed. This is not permission to change h, body count, replay policy, or hidden quality-dependent physics.

### Evidence required for review

Candidate, example scenes, recorded action sequences, keyboard/access checks, before/after evidence for material usability fixes, owner/tester notes, and regression performance results. Every screenshot used as evidence identifies the actual candidate.

### Failure / rollback conditions

Block for inaccessible essential controls, selection occlusion, a slider-dominated core workflow, misleading history labels, or polish that breaks performance/semantics. Restore the last legible functional presentation and address the specific problem. Do not broaden into another application to solve a layout issue.

### Unlocks

A product whose operating envelope and final native candidate presentation are worth qualifying for owner review.

## M9 — Measure and secure the performance envelope

### Objective

Establish a reproducible supported capacity and keep manipulation responsive, adding acceleration only where measured need justifies it.

### Why now

Representative scenes and final interactions exist, so optimization can target the actual product. Earlier measurements have already prevented obvious regressions.

### In scope

- Full P0/P1/P2/P3 measurements and resource-cycle checks under SPEC §18.
- Profile allocation, kernel/solver cost, frame work, draw calls, trace/probe cost, input acknowledgment, seek and baseline calculation.
- Fix demonstrated bottlenecks through cached transforms/compilation, bounded buffers, instancing and avoiding unnecessary work.
- Conditional dedicated-worker migration if CPU simulation demonstrably blocks interaction after simpler fixes.
- Conditional PX WebGPU-compute experiment if a useful dense workload fails its CPU evaluation/simulation budget; prefer TSL and the existing renderer's modern compute/node facilities.
- Raw WGSL only with an explicit workload, demonstrated TSL limitation/overhead, and correctness/performance evidence for the lower-level implementation.
- CPU evaluator fallback and explicit approximate-probe semantics for any admitted compute target; this is independent of optional renderer-provided WebGL 2 compatibility.

### Out of scope

Mandatory advanced GPU compute, authoritative GPU rigid-body simulation, million-body goals, renderer-migration work, hand-maintained duplicate GLSL paths, broad renderer rewrites, shared-memory infrastructure by default, parallel worlds driven by independent wall clocks, and changing supported scenes to hide a failure. WebGPU graphics remain the primary path throughout.

### Deliverables

A reproducible benchmark runner/protocol, raw per-run results, bottleneck evidence, any justified bounded optimizations, resource-lifecycle checks, and a written compute/worker decision inside this milestone's evidence. **Keeping CPU/WASM simulation under the existing WebGPU renderer is a valid outcome.**

### Acceptance criteria

1. P0/P1/P2/P3 meet all applicable SPEC §18 targets in the actual packaged `Lawsmith.app` on the owner's qualified Mac. Each result records hardware, macOS/Tauri/WRY/WebKit identity, build/profile, actual WebGPU backend, exposed adapter/features, content viewport/DPR, power mode, warmup and all three runs. Test servers/plugins and command mocks are absent.
2. Report observed p50/p95/p99 and worst run for steps, CPU frame work, foreground callback intervals and edit-to-frame-submission latency. Distinguish CPU submission time from GPU execution; report GPU-timing availability. Do not claim input-to-photon/presented-frame measurement from a callback timestamp, average percentiles, or substitute a favorable empty scene.
3. At 1×, each supported workload achieves simulated/wall time ≥0.98 during measurement without skipped ticks or adaptive h.
4. Twenty scene-load/reset cycles and twenty seek/fork cycles return engine/render counts and buffers to bounded steady state. Checkpoint/trace/comparison limits are enforced and accounted.
5. Every optimization is tied to a measured bottleneck and before/after result; existing exact replay and semantic tests continue to pass.
6. If a worker is added, the same command log produces exact state as the pre-migration host; UI acknowledgment and input-latency evidence show the intended benefit. No second authority or timing-dependent state enters the design.
7. If GPU field evaluation/simulation is added, a useful PX workload shows the required ≥2× measured computation-cost improvement or useful new density at the same budget. The shared semantic representation lowers to CPU and TSL/generated WGSL targets; 10,000-sample differential checks and any moved integrator's error budget pass. Unsupported nodes choose CPU evaluation. Raw WGSL additionally demonstrates why TSL is insufficient for that workload.
8. With advanced compute disabled and WebGPURenderer still active on WebGPU, the entire P0 defining demo, CPU/WASM creative core and two-future workflow remain qualified. If compute work fails its admission/equivalence gate, omit it and accept only after the required envelope passes. Test only the renderer-provided compatibility subset actually offered; do not build a second graphics implementation to make it equivalent.

### Required tests

Complete T11; rerun affected T03/T04/T08/T09/T10 for numerical or authority changes. If advanced compute is admitted, add finite/boundary/core/transformed-support equivalence fixtures, any moved integrator tests, CPU-execution fallback, device-loss handling and explicit precision limits. A graphics screenshot is not GPU math validation. If sleeping is proposed as an optimization, it requires moved/animated-law wake tests and exact checkpoint continuation before acceptance.

### Visual QA

Manipulate fields in the real native app during each benchmark scene and during a cancelable seek/baseline calculation. Verify degraded optional visualization is explicit and does not change physics. For optional acceleration, compare density/meaning/legends and failure behavior, not just a smooth animation with no controls. Keep separate pure-kernel/headless timings labeled; they do not qualify native window/runtime performance.

### Performance gate

This milestone owns final performance qualification. SPEC §18 is the gate. A target change requires an explicit revised supported envelope and owner review; it cannot be introduced as a quiet fixture adjustment. Dense-compute success cannot compensate for failing P0/P1 authoring under the primary WebGPU renderer.

### Evidence required for review

Candidate, benchmark scene artifacts, protocol and raw results, actual renderer/backend, profile traces showing bottlenecks, before/after measurements, resource counts and byte budgets, replay regression results, and the decision to retain CPU/WASM simulation or add bounded WebGPU compute. Report optional compute targets as omitted/accepted/failed; report any raw-WGSL justification explicitly.

### Failure / rollback conditions

Block for unexplained missed latency targets, memory growth, changed authority results, missing CPU-compute fallback, unqualified raw WGSL, or a worker/compute rewrite without measured benefit. Revert the optional optimization to the last correct host and existing WebGPU renderer and retain the evidence. If the required envelope still fails, resolve that concrete shortfall before M10.

### Unlocks

An evidence-backed operating envelope and stable foundation for the flagship candidate.

## M10 — Flagship release candidate

### Objective

Produce and verify the actual macOS `Lawsmith.app` candidate with real examples, clear documentation and memorable demonstrations, ready for the owner's separate release/distribution decision.

### Why now

The product, replay semantics and performance envelope have passed their gates. The final task is to make the capability inspectable and reproducible by someone new.

### In scope

- Final integration fixes and a frozen source/candidate identity with npm/Cargo lockfiles, toolchain and simulation/runtime profile.
- README, architecture/control/extension guidance, supported macOS application/runtime and determinism limitations, reproducible Tauri dev/build/launch/test commands.
- Actual Apple Silicon `.app` production bundle, five editable examples, portable scene/run fixtures, candidate screenshots and short GIF/video demos.
- Fresh-checkout deterministic dependency installation and Tauri production build; fresh-app/recovery-state native verification with Vite stopped and no runtime network dependency.
- Actual WKWebView with actively confirmed WebGPU backend, CPU/WASM simulation with advanced compute disabled, native window/drag/traffic lights, desktop files, lifecycle, errors and recovery; separately test any renderer-provided compatibility subset actually offered.
- Full defining demo, compound-law demonstration, M6A exact linear replay, M6B seek and controlled two-future proof.
- Release notes identifying accepted capabilities, deferred work and measured capacity.

### Out of scope

Feature expansion, new engine/profile upgrades for novelty, mandatory advanced GPU compute, scientific-certification or universal exact-replay claims, Safari/Chrome browser release qualification, Windows/Linux support, Electron, public deployment, distribution signing/notarization, installer/updater engineering and unrequested native integrations. Signing or another packaging step is included only if genuinely required to execute this local candidate. WebGPU graphics and modern node materials remain foundational; no website or public release is an acceptance requirement.

### Deliverables

A named immutable source candidate and its actual `Lawsmith.app`; documented build/launch path, editable examples and test fixtures, clear README/controls, real native-window imagery/videos, compact final acceptance evidence and known limitations. Identify the built bundle and toolchain rather than only a frontend URL. A repository tag, signing/notarization for distribution, publication or public release requires its own authorization in that implementation session.

### Acceptance criteria

1. From a fresh checkout, documented locked dependency installation, type-check/tests and Tauri production build succeed using the recorded toolchain. Launch the resulting Apple Silicon `Lawsmith.app` with Vite stopped and no external runtime network connection. Core use needs no secrets, local server or remote website.
2. Repeat all ten defining-demo steps inside that exact app candidate, including real native scene save/open at user-chosen locations, fresh app launch and equal-tick repeatability in the qualified runtime.
3. Build/manipulate the Storm Bottle and demonstrate true sampled contributions; save/open a recorded intervention and prove M6A exact replay; verify M6B restored seek against its uninterrupted reference; compare two computed futures from one complete identical fork.
4. The five bundled scenes open paused or under an explicit autoplay preference, are editable, and export/reload with preserved semantics.
5. All required T01–T12 cases and P0–P3 gates pass on the primary WebGPU path, with conditional advanced-compute checks clearly marked not applicable when omitted. No optional-compute omission is confused with omitting WebGPURenderer.
6. Actual package smoke/visual/replay evidence records the full Lawsmith/Tauri/WRY/macOS/WKWebView identity and confirms the real WebGPU rendering backend. WebGL fallback, Safari.app, headless WebKit and Chrome cannot substitute for this result. A browser failure alone is nonblocking for this macOS-only product.
7. Reset, native scene/run saves, application-local recovery, exact qualified replay, checkpoint and session-local branching limitations are documented clearly, including center sampling and external-force versus contact explanations. Semantic portability is distinguished from exact runtime equality.
8. README images and demos come from the actual candidate `Lawsmith.app` window. No browser screenshot, mockup or generated animation is presented as evidence of the native implementation. Whole-window evidence shows the continuous surface and native traffic lights.
9. There is no unresolved defect blocking law manipulation, native open/save, recovery/close protection, semantic portability, exact supported replay, controlled comparison, essential keyboard/UI-scale access, natural window dragging or the declared performance envelope.
10. Independent review verifies the candidate and evidence against this plan without relying on implementation self-attestation alone.
11. The shipping app has no embedded E2E server, command mocks or mandatory remote assets. Test-instrumented native checks remain separately identified; final window/file/visual/performance checks use the uninstrumented candidate. No public deployment or Safari/Windows/Linux acceptance gate is added.

### Required tests

Run the complete required acceptance suite once on the candidate and repeat only affected checks after a fix. Combine domain tests, explicitly labeled frontend harness checks and actual native integration/visual QA under SPEC §17.3. Test fresh app-local recovery, native open/save/cancel/failure/close flows, minimize/Hide/sleep/resume, native traffic lights and invisible dragging. Exercise only an offered renderer compatibility subset, without counting it as the primary path. Verify documented commands and package loading from a clean source/build environment; no automation tool is assumed to drive WKWebView without qualification.

### Visual QA

Record the three flagship proofs continuously from the actual `Lawsmith.app` candidate. Inspect compact/default content sizes, 200% Interface Scale, keyboard/native-file authoring and comparison clarity. Verify the entire continuous window surface, traffic lights, drag hit targets and normal fullscreen behavior. Ask a new tester to open an example, change a law, save it through the native workflow and explain the motion using the app's cues. Record remaining limitations honestly.

### Performance gate

Reuse M9 measurements only if the candidate's affected code/settings, package mode and qualified native/runtime identity have not changed. Otherwise rerun the affected workloads in the actual app. Confirm final visuals retain measured density/DPR policies and the documented envelope matches the fixture results. Browser or headless throughput cannot replace packaged-app latency and pacing evidence.

### Evidence required for review

Exact candidate/base and built `.app` identity, final diff, toolchain/lockfile/build/launch results, qualified runtime and actual backend, native QA records, benchmark references, native-saved scene/run fixtures, the three real app demos, documentation verification and known limitations. **Independent review gate:** make a clear accept/reject decision for this candidate with evidence for each material issue.

### Failure / rollback conditions

Block acceptance for missing actual `.app`/WKWebView/WebGPU evidence, broken package assets/native files/window controls, unverifiable replay/comparison, regressions hidden by optional compute or test mocks, or omitted material limitations. Fix the concrete release-blocking issue and recheck affected gates; retain the previous accepted candidate. An unsupported Safari/Chrome result does not block acceptance. A genuine Tauri incompatibility requires owner replan, never a silent shell switch. Owner distribution/public-release approval is a later action, not inferred from a successful suite.

### Unlocks

A flagship personal project worth sharing, with an explicit owner decision about release and a clean basis for separately scoped future capabilities.

## Contract coverage and final scope check

| Requirement | First accepted evidence | Strengthened later |
| --- | --- | --- |
| Direct spatial law manipulation | M1 | M3 handles, M5 compound law, M8 usability |
| Full ten-step defining demonstration | M2 | M10 fresh-candidate repeat |
| Semantic/render separation and one authority | M1 | M2 persistence, M6A replay contexts, M6B restoration, M9 optional transport |
| Stable field/region mathematics | M1 directional/box | M3 primitives/shapes, M5 composition |
| Honest visualization | M1 arrows | M4 contributions/probes, M7 alternatives |
| Exact reset in qualified app/runtime | M1 | M2 native load/reset, M6A recorded inputs |
| Frozen root, exact linear replay and native run files | M6A | M6B checkpoint-disabled oracle, M10 app qualification |
| Complete checkpoints and seek equal to linear replay | M6B after M6A | Independent complete-state review before M7, M10 qualification |
| Baseline and alternate from the same state | M7 | M8 clarity, M10 flagship proof |
| Native scene files, reliable replacement and app-local recovery | M2 | M5 expressions, M6A run files, M10 package workflows |
| Keyboard access and clear control labels | Begins with each control | M8 comprehensive check, M10 regression |
| Measured performance | M1 P0 | M3/M4/M7 expanded workloads, M9 final envelope |
| Tauri/WKWebView, WebGPU-first renderer, TSL default, bundled assets | M0 dev and packaged app | Every visual milestone; M10 actual application qualification |
| Continuous window surface, native traffic lights, invisible drag regions | M0 | M1 pointer ownership, M8 UI scale/layout, M10 whole-window evidence |
| Conditional worker/advanced GPU compute; measured raw-WGSL escape hatch | M9 if justified | CPU/GPU differential tests, CPU-compute fallback, M10 verification |

No milestone grants permission to build an excluded future idea merely because an interface could support it. The approved stopping points remain portable V0 at M2, creative core at M5, and flagship candidate at M10. The core loop must remain enjoyable at every one.

**End of plan.**
