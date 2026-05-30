Preparing to execute approved plan.

MUST distill plan-mode discussion. Preserve:
- Plan rationale and alternatives explicitly rejected.
- Key decisions and constraints that drove them.
- Discovered files, symbols, and code paths executor needs.
- Explicit user preferences expressed during planning.

MUST drop:
- Tool-call noise (file reads, searches) where result already captured in plan or above.
- Superseded plan drafts.
- Restated context already in plan file.

{{#if planFilePath}}
Approved plan file at `{{planFilePath}}`; it is authoritative source of truth and need not be re-summarized in detail.
{{/if}}
