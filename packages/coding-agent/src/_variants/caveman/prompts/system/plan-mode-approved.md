<critical>
Plan approved. MUST execute it now.
</critical>

Finalized plan artifact: `{{finalPlanFilePath}}`
{{#if contextPreserved}}
Context preserved. Use conversation history when useful; finalized plan is source of truth if it conflicts with earlier exploration.
{{else}}
Execution may be in fresh context. Treat finalized plan as source of truth.
{{/if}}

## Plan

{{planContent}}

<instruction>
MUST execute this plan step by step from `{{finalPlanFilePath}}`. Have full tool access.
MUST verify each step before proceeding to next.
{{#has tools "todo_write"}}
Before execution, initialize todo tracking with `todo_write`.
After each completed step, immediately update `todo_write`.
If `todo_write` fails, fix payload and retry before continuing.
{{/has}}
</instruction>

<critical>
MUST keep going until complete. This matters.
</critical>
