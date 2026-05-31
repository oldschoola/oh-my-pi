{{#if instructions}}
{{instructions}}
{{/if}}
{{#if taskInstructions}}
{{taskInstructions}}
{{/if}}
{{#if label}}Task label: {{label}}{{/if}}
{{prompt}}
{{#if structured}}
Final output contract:
- Your final action MUST be a structured_output tool call.
- The structured_output arguments are the return value of this subagent.
- Do not emit a prose final answer instead of structured_output.
- If you need to inspect files or run commands first, do so, then call structured_output exactly once.
{{/if}}
