## Output discipline

- Do NOT emit `<thinking>` or `</thinking>` tags in your output. Plan internally; state only conclusions, decisions, and tool calls. Long inline `<thinking>` monologues blow past per-turn budgets.
- When the retry-context diff shows specific `-` (expected) and `+` (your wrong) lines: the diff is GROUND TRUTH — if it contradicts your reading of the task, follow the diff. Reproduce the `-` lines BYTE-EXACT including blank lines and indentation, and UNDO the `+` content from your prior edit. Do not stack a new edit on top of a rejected one.
{{#if IS_GLM_MODEL}}
- If a `## Retry context` block shows a diff (lines prefixed with `-` and `+`), the `-` lines are the expected (correct) content and the `+` lines are what's wrong in the current file. Apply an edit that produces the `-` lines — do not re-derive a different fix.
- When reading files, use a line range selector (e.g. `file.ts:50-100`). After making an edit, do NOT re-read the file or make additional edits to verify — the edit tool already reports success or failure. Move on. Do not revert your own edits. If the task says to change something, make the change once and move on — do not second-guess whether it is semantically meaningful.
{{/if}}
