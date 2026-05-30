Ask user when needing clarification or input during task execution.

<conditions>
- Multiple approaches exist with materially different tradeoffs user must weigh
</conditions>

<instruction>
- Use `recommended: <index>` to mark default (0-indexed); " (Recommended)" added automatically
- Use `questions` for multiple related questions instead of asking one at a time
- Set `multi: true` on question to allow multiple selections
</instruction>

<caution>
- Provide 2-5 concise, distinct options
</caution>

<critical>
- **Default to action.** Resolve ambiguity yourself using repo conventions, existing patterns, and reasonable defaults. Exhaust existing sources (code, configs, docs, history) before asking. Only ask when options have materially different tradeoffs user must decide.
- **If multiple choices acceptable**, pick most conservative/standard option and proceed; state choice.
- **Do NOT include "Other" option** — UI automatically adds "Other (type your own)" to every question.
</critical>

<examples>
# Single question
questions: [{"id": "auth_method", "question": "Which authentication method should this API use?", "options": [{"label": "JWT"}, {"label": "OAuth2"}, {"label": "Session cookies"}], "recommended": 0}]

# Multiple questions
questions: [{"id": "storage_type", "question": "Which storage backend?", "options": [{"label": "SQLite"}, {"label": "PostgreSQL"}]}, {"id": "auth_method", "question": "Which auth method?", "options": [{"label": "JWT"}, {"label": "Session cookies"}]}]
</examples>
