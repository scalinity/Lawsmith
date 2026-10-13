# M9 independent source review — 2026-10-13

Reviewer: GPT-6.1 Sol, independent of Opus 5.5 implementation. Read-only source review; no edits, tests, builds or native actions.

- Base: `71e9b517aff413bacf8c5bb7a317933e63e8c6e0`.
- Application/tooling candidate: `02fd2ba40ffdf8731f38e1d312e9143496c2058c`.
- Additional work-limit tooling reviewed: `937ac6ff71060707e1fd0947f37be66e1313825d`.
- Verdict: **remediation required before native execution**. Final capacity and worker/compute decision remain PENDING.

## Findings

| ID | Priority | Source at reviewed candidate | Reachable failure | Required correction | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | P1 | `scripts/verify/native/m9-batch.zsh:119,198`; `lib.zsh:189–198` | Driver cancellation before the delayed `launched pid` line can kill the runner while leaving the detached packaged app alive. The app is absent from the PID receipt and its argv does not contain the scenario directory. | Record recoverable exact app ownership from launch; prove cleanup before readiness reporting. | Corrected and checked; independent re-review pending |
| R2 | P1 | `m9-resources.zsh:58,125`; `m9-perf.zsh:172`; shared `wait_log`/`segment` | Outside input during passive fixture/capture waits is not sampled. The next segment's quiet wait resets `LAST_INPUT`, so a batch can resume after the person used the Mac. | Check outside input throughout waits and keep it terminal; subsequent segments must not erase it. | Corrected and checked; independent re-review pending |
| R3 | P2 | `m9-batch.zsh:203–218` | A final restoration failure can write `final.exit: 0` and print success before the actual exit is changed to 6. | Resolve final exit before writing receipts/messages; test final-only restoration failure. | Corrected and checked; independent re-review pending |
| R4 | P2 | `src/main.ts:3671`; `worldView.ts:273–289` | Attached-scene traversal loses sight of a detached view's undisposed material, allowing a material disposal leak to pass steadiness. | Count owned allocation/disposal including detached retained views; prove a missed disposal is detected. | Corrected and checked; independent re-review pending |

R1–R3 enforce AGENTS Native QA and Process lifecycle; R4 enforces SPEC §18.2's geometry/material/world resource gate and M9 AC4.

## Confirmed source observations

P3 follows warmup → fork restoration → full baseline precomputation → measurement in source. The additional maximum-work fixture and runner are explicitly characterization, not supported capacity or PX admission. No additional actionable defect was found in that narrow delta. No worker or GPU compute implementation was introduced.

## Unverified by this review

The final packaged candidate, P0–P3 numeric captures, resource cycles, native cancellation/manipulation, human observations and measurement-based worker/compute decision remain pending. Inspected headless receipts establish preparation only.
