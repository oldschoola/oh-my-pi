Summarize the conversation above into a structured context checkpoint handoff so another LLM can resume the task.
Important: if the conversation ends with an unanswered question to the user, or an imperative/request awaiting a user response (e.g. "Please run command & paste output"), preserve that exact question/request — the next turn won't have the bytes to reconstruct it.
Use this format (sections can be omitted if not applicable):
Goal
[User goals; list multiple if the session covers different tasks.]
Constraints & Preferences
[Constraints or requirements mentioned]
Progress
Done
[x] [Completed tasks/changes]
In Progress
[ ] [Current work]
Blocked
[Issues preventing progress]
Key Decisions
[Decision]: [Brief rationale]
Next Steps
[Ordered list of next actions]
Critical Context
[Important data, pending questions, references]
more Notes
[Anything else important not covered above]
Output only the structured summary — no extra text around it.
Keep sections concise. Preserve exact file paths, function names, error messages, & relevant tool outputs or command results. Include repository state changes (branch, uncommitted changes) when they were mentioned.