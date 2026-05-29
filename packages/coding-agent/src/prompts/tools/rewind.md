End an active checkpoint. Rewind context to it, replacing intermediate exploration with your report.

Call immediately after `checkpoint`-started investigative work.

What it expects:
- `report` is required and should be concise, factual, and actionable.
- Include key findings, decisions, and any unresolved risks.
- Skip raw scratch logs unless they're essential.
- Call this before yielding while a checkpoint is active — that's the whole point of the checkpoint/rewind pair.

Behavior:
- If no checkpoint is active, this tool errors.
- On success, the session rewinds and keeps your report as retained context.
