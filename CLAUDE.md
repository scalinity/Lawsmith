# Lawsmith

@AGENTS.md

## Claude Code

- Schedule native-QA hands-off windows with `AskUserQuestion`. Offer "you drive, I step away" and "I'll run the checklist myself".
- For an independent review, dispatch a read-only reviewer subagent with the candidate SHA, the diff range and the milestone's section of `docs/MILESTONES.md`, then run `/address` on its report.
