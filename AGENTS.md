# Lawsmith agent instructions

Lawsmith is a native macOS creative instrument in which physical laws are spatially manipulable objects. It uses a Tauri 3 shell (WRY runtime, system WKWebView), a TypeScript frontend with Three.js WebGPURenderer, and Rapier WASM physics. This file holds the project's working conventions. Your global instructions still apply and are not repeated here.

## Sources of truth

| File | Holds | Read it |
| --- | --- | --- |
| `docs/SPEC.md` | Product contracts, equations, architecture, state ownership | Before any milestone, and whenever a design question arises |
| `docs/MILESTONES.md` | Per-gate scope, out-of-scope, acceptance criteria, required tests | Before and during a milestone, because it defines *done* |
| `docs/evidence/M<n>.md` | Per-milestone qualification record; captures in `docs/evidence/m<n>/` | The latest one, before starting the next milestone: its open findings feed forward |
| `ORCHESTRATION.html` | Run order, model allocation, eligibility, open threads | To decide what runs next, and at close-out to realign |
| `README.md` | Prerequisites and dev/build/launch commands | When setting up or running the app |

SPEC and MILESTONES are the authority and stay read-only during ordinary work. If a requirement is contradictory or cannot be implemented as written, stop the affected work, collect the evidence and report it for an owner decision. Change the specification only with explicit owner authorization. Edit it in place so it reads as the current design.

## Units of work

- A session owns one **unit**: a milestone, a review fix-up, or an owner-requested task. It ends at that unit's close-out. The next unit starts in a fresh session from `main`, so each session's context and evidence stay attributable to one candidate.
- Milestone states: `NOT STARTED → IN PROGRESS → IMPLEMENTED / REVIEW PENDING → ACCEPTED`, plus `BLOCKED` and `OWNER NATIVE CHECK REQUIRED`. Only the owner marks a milestone ACCEPTED. Merging to `main` is a git fact, not acceptance.
- Acceptance criteria are conjunctive. A check is PASS only when it ran on the candidate and its result was captured. A native check you could not run is PENDING, with exact owner steps.
- Build what the current milestone needs now. Work "for later" belongs to the milestone that uses it.

## Stack facts that are easy to get wrong

- **Exact pins.** Tauri 3 is prerelease, and its crates carry different alpha numbers (for example `tauri 3.0.0-alpha.4` with `tauri-build 3.0.0-alpha.3`). Resolve a family from the release tag and crate metadata, pin with `=`, and commit both lockfiles. Upgrading a dependency, Tauri, macOS or the toolchain is its own qualified change, because the runtime identity is part of the exact-replay guarantee.
- **Backend boundary.** `src/rendering/backend.ts` is the only module that reads three.js renderer internals. Extend it there, so a three.js upgrade touches one file. A WebGL 2 backend is a startup failure to report.
- **Rapier `dt` is f32.** It reads back as `0.008333333767950535`, not exactly 1/120. Determinism fixtures compare against the engine-reported value.
- **Rapier reads `performance` from `window` in tests.** Vitest runs in Node, where `window` is undefined. If a test defines `window`, Rapier's WASM reads `window.performance` on every step. A stand-in without it makes each step panic with `unreachable` and leaves the instance broken for the rest of the file. Give the stand-in the real `performance`, as `tests/lawGesture.test.ts` does.
- **UI tokens.** Colors and type come from the `:root` tokens in `src/style.css` (warm-ink dark palette, system sans, serif for display moments, mono for diagnostics). Add a token there rather than a literal in a component.
- **Diagnostics channel.** `report(kind, data)` in `src/main.ts` writes one JSON line per event to the console and, through the native `report` command, to stderr prefixed `[lawsmith]`. New qualification signals go through it. It writes `kind`, `mode` and `t` itself, so event data cannot overwrite them.

## Verification

The verification commands in `README.md` (`npm ci`, `npm run typecheck`, `npm run build`, `cargo check` in `src-tauri/`, `npx tauri dev`, `npx tauri build --bundles app`) are authorized whenever a milestone's required tests call for them.

- Verify interactions from the `[lawsmith]` log (gizmo, orbit, control, resize, pacing events), with captures as supporting evidence. `README.md` shows how to capture the packaged app's log.
- `npm ci` reports `fsevents` install scripts as blocked; that is expected, and the package works without them.
- Vite reloads the page on every source edit and resets scene state. Finish a native test sequence before editing sources that `tauri dev` is serving.
- `VITE_LAWSMITH_FAULT=webgl|rapier-hang` injects startup faults in dev only. After changing startup code, confirm the fault strings are absent from `dist/assets`.

## Test scope

Test what the current unit changed, not everything that exists.

1. **Scope is the current milestone.** Test its newly implemented or changed behavior and its explicit acceptance requirements. Do not schedule whole native campaigns or every historic test from accepted milestones because they exist. An older helper or fixture may serve a narrow current integration check, or a concrete, reproducible regression witness; say how it links to the changed behavior. An explicit owner scope override wins. A full acceptance sweep belongs only to an explicit release gate (M10) or an owner request.
2. **Build and test the final candidate once.** Run the targeted headless tests, source checks and one build on the final affected application candidate, and keep its runtime identity. Docs-only or harness-only edits do not trigger an application rebuild or the full suite.
3. **Reuse valid results.** A passed result stays valid while its producing application, the affected source, and the relevant settings and workload are unchanged. Do not invalidate unaffected cases because docs or unrelated code changed. After a fix, rerun the failing and affected cases, not a whole historic milestone. A global layout change may still affect a whole matrix: say so, and never understate the impact or record a PASS that did not run.
4. **Performance runs only on a relevant change.** Never restart a passed performance campaign without a relevant change. When one is required, keep its prescribed workloads, warmup and capture durations.

## Native QA

The owner uses this Mac while sessions run, so synthetic input is scheduled and guarded, and the Mac is reserved only while native actions actually run:

1. **Prepare outside the hands-off period.** Deterministic fixtures, drivers, parsers, keyboard and focus preflight, and source review all happen before the Mac is reserved. Inside it, start with the riskiest native smoke checks (for a layout milestone: compact 200% and the mandatory 1280×800 at 200%) before the full matrix, so a failure stops cheaply. Ordinary UI qualification plans for at most 15 minutes of foreground interaction, excluding prescribed performance minimums. That is a planning target, not a measurement or a waiver.
2. **One authorization per declared batch, with no extension prompts.** Before any synthetic mouse or keyboard input, declare a bounded batch (the scenarios and their measured or estimated occupancy) and get the owner's go-ahead. That authorization lasts until the batch finishes and the Mac's state is restored. Do not ask the owner to choose a fixed window length, and do not ask to renew or extend one. Warn just before the batch starts, and say when it is over. `QA_DEADLINE` is then each scenario's finite safety deadline inside the batch, not a renewal point.
3. **Release the Mac between batches.** When a check fails, restore and release the Mac before debugging, editing or review. Then resume only the affected or unrun checks under the same authorization, if the owner is still hands-off.
4. **The person always wins.** An explicit owner end time or cancel takes precedence: stop, restore, and record unfinished checks as pending, without asking for more time. Outside input makes the run yield and restore; it never keeps clicking against the person, and it does not resume automatically while they are active.
5. **Guards stay.** Keep the shared GUI lock, disposable state, restoration and each scenario's finite watchdog. Do not reuse an old private campaign driver whose checks assume a fixed approved window, and do not alter old approval records: new completion-based batches use their own matching metadata.
6. Before every synthetic click or drag, hit-test that point: the topmost on-screen window there must belong to Lawsmith (window owner `lawsmith` in dev, `Lawsmith` packaged). A window capture (`screencapture -l`) renders a covered window as if it were visible, so it never shows what is on top. Keys require the app to be frontmost.
7. Capture the whole window, never a cropped canvas. Store a few captures in `docs/evidence/m<n>/`.
8. The built-in display currently provides 1168×755 pt, and macOS clamps larger windows. The 1280×800 and 1600×1000 content-size checks are owner checks under a "More Space" display setting or an external display.
9. Synthetic drags sometimes lose their mouse-up (`docs/evidence/M0.md`, finding 1). Confirm pointer-ownership conclusions on a real trackpad as an owner check.
10. **Human checks are human.** Before close-out, give the owner one concise checklist of the observations that only a person can make, and the current milestone's interactions no run covered. A synthetic assertion never stands in for human exploration or a real trackpad.

Evidence lives in one `docs/evidence/M<n>.md` per milestone, shaped like M0's. Every figure traces to a captured log, command output or image.

## Reviews

When a review report arrives (from a reviewer agent, a code-review run or the owner), run the `address` skill on it: `/address` in Claude Code, `source-command-address` in Codex. Address **every** finding, whether critical, warning or suggestion. A finding is closed by a fix, verified by re-running the checks it affects. There is one exception. If a fix would break a SPEC or MILESTONES contract or an owner decision, answer the finding in writing with the evidence and surface it to the owner as an open item. Record the review and its resolution in the milestone's evidence file. `address` commits and pushes each fix to the current branch; close-out still merges that branch.

## ORCHESTRATION.html

`ORCHESTRATION.html` in the project root is the owner's run-order page and follows the global orchestration-overview rules. For this project:

- Its record is `docs/MILESTONES.md` (gates, dependencies, scope), the `docs/evidence/M<n>.md` files (status, findings, owner checks) and `git log` on `main`. Take figures from those.
- Realign it during close-out in every session that does any of these:
  - finishes or blocks a unit;
  - changes what can run next;
  - opens or closes a finding;
  - moves a file-ownership boundary.

  Update the affected strip state, eligibility lines and open threads in place.
- Realign before the final commit, so the page reaches `main` with the work it describes. If the page has uncommitted changes or another session owns it, leave it and report what would have changed.

## Git workflow

Each session starts from `main` and ends with its work merged and pushed to `main`, so the next session starts clean. `scalinity/Lawsmith` on GitHub is **public**: every push publishes.

**Start**
1. `git switch main && git pull --ff-only`. The tree is clean. `git worktree list` and `ORCHESTRATION.html` (once it exists) show which branches and files other in-flight sessions own.
2. Read this file's sources of truth for your unit, then create a branch named for it: `m1`, `m1-pointer-guard`, `orchestration`.

**Work**
- Commit in small, coherent steps and stage files by name.
- Push the branch with `git push -u origin <branch>` whenever useful. `address` pushes on its own.

**Close-out**: in order. Each step's criterion holds before the next begins.
1. **Verified**: every required check for the unit has run, and its result is in the evidence file.
2. **Realigned**: `ORCHESTRATION.html` reflects the unit's outcome, per the section above.
3. **Committed**: `git status` is clean on the branch.
4. **Merged**: `git switch main && git pull --ff-only && git merge --ff-only <branch>`. If a fast-forward is impossible, run `git merge --no-ff <branch>`, resolve conflicts keeping both sides' intent, then re-run `npm run typecheck` and `npm run build` on `main`. Criterion: `main` contains the branch and is green.
5. **Pushed**: `git push origin main`. Criterion: `git rev-parse main` equals `git rev-parse origin/main`.
6. **Branch discarded, when safe**: `git merge-base --is-ancestor <branch> origin/main` succeeds, `git worktree list` shows the branch checked out nowhere, and no other session uses it. Then run `git push origin --delete <branch>` (if it exists on GitHub) and `git branch -d <branch>`. If `-d` refuses, the branch holds unmerged work: keep it and report it.
7. **Reported**: the final report states the pushed `main` SHA, the discarded branch and what changed on `ORCHESTRATION.html`.

**Guardrails**
- `main` moves forward only: merge into it, and keep published history as it is.
- Before pushing a new kind of artifact (logs, captures, fixtures), check it for credentials and personal identifiers.
- Tags, releases, repository settings and visibility are owner decisions.
- An owner's session prompt may explicitly override any default in this file.
