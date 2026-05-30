End active checkpoint. Rewind context to it, replacing intermediate exploration with your report.

Call immediately after `checkpoint`-started investigative work.

Requirements:
- `report` REQUIRED and must be concise, factual, and actionable.
- Include key findings, decisions, and any unresolved risks.
- Do not include raw scratch logs unless essential.
- MUST call this before yielding if checkpoint active.

Behavior:
- If no checkpoint active, this tool errors.
- On success, session rewinds and keeps your report as retained context.
