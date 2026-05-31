{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
Incorporate the new messages above into the existing handoff summary in <previous-summary> tags — the merged summary is what the next LLM uses to resume.
Rules:
Preserve all information from the previous summary
Add new progress, decisions, & context from the new messages
Update Progress: move items from "In Progress" to "Done" when completed
Update "Next Steps" based on what was accomplished
Preserve exact file paths, function names, & error messages
Remove anything no longer relevant
Important: if the new messages end with an unanswered question or request to the user, add it to Critical Context (replacing any previous pending question if answered).
Use this format (omit sections if not applicable):
Goal
[Preserve existing goals; add new ones if the task expanded]
Constraints & Preferences
[Preserve existing; add new ones discovered]
Progress
Done
[x] [Include before done & newly completed items]
In Progress
[ ] [Current work — update based on progress]
Blocked
[Current blockers — remove if resolved]
Key Decisions
[Decision]: [Brief rationale] (preserve all previous, add new)
Next Steps
[Update based on current state]
Critical Context
[Preserve important context; add new if needed]
more Notes
[Other important info not fitting above]
Output only the structured summary — no extra text.
Keep sections concise. Preserve relevant tool outputs/command results. Include repository state changes (branch, uncommitted changes) when they were mentioned.