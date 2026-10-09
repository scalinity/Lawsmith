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

## Native QA

The owner uses this Mac while sessions run, so synthetic input is scheduled and guarded:

1. Agree a **hands-off window** with the owner before any synthetic mouse or keyboard input. Warn just before it starts, and say when it is over.
2. Before every synthetic click or drag, hit-test that point: the topmost on-screen window there must belong to Lawsmith (window owner `lawsmith` in dev, `Lawsmith` packaged). A window capture (`screencapture -l`) renders a covered window as if it were visible, so it never shows what is on top.
3. Capture the whole window, never a cropped canvas. Store a few captures in `docs/evidence/m<n>/`.
4. The built-in display currently provides 1168×755 pt, and macOS clamps larger windows. The 1280×800 and 1600×1000 content-size checks are owner checks under a "More Space" display setting or an external display.
5. Synthetic drags sometimes lose their mouse-up (`docs/evidence/M0.md`, finding 1). Confirm pointer-ownership conclusions on a real trackpad as an owner check.

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
