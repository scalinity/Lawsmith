# Lawsmith

@AGENTS.md

## Claude Code

- Native QA follows `AGENTS.md` ("Test scope" and "Native QA"): declare one bounded batch and get the go-ahead once, which lasts until the batch finishes and the Mac is restored. Never ask the owner for a window length, an extension or a renewal. Use `AskUserQuestion` only for that first go-ahead, offering "you drive, I step away" and "I'll run the checklist myself".
- For an independent review, dispatch a read-only reviewer subagent with the candidate SHA, the diff range and the milestone's section of `docs/MILESTONES.md`, then run `/address` on its report.
