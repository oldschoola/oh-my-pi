{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
<critical>
Write a handoff document for another instance of yourself.
It needs to be enough for seamless continuation without access to this conversation.
Output ONLY the handoff document — no preamble, no commentary, no wrapper text.
<instruction>
Capture exact technical state, not abstractions.
File paths, symbol names, commands run
Test results, observed failures
Decisions made
Partial work affecting the next step
<output>
Use exactly this structure:
Goal
[What the user is trying to accomplish]
Constraints & Preferences
[Any constraints, preferences, or requirements mentioned]
Progress
Done
[x] [Completed tasks with specifics]
In Progress
[ ] [Current work if any]
Pending
[ ] [Tasks mentioned but not started]
Key Decisions
[Decision]: [Rationale]
Critical Context
Code snippets, file paths, function/type names, error messages, data essential to continue
Repository state if relevant
Next Steps
[What should happen next]
{{#if additionalFocus}}
more focus: {{additionalFocus}}
{{/if}}