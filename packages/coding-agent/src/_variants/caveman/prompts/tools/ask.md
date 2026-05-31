{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
Asks user when you need clarification or input during task execution.
<conditions>
Multiple approaches exist with significantly different tradeoffs the user should weigh
<instruction>
Use `recommended: <index>` to mark default (0-indexed); " (Recommended)" is added automatically
Use `questions` for multiple related questions instead of asking one at a time
Set `multi: true` on a question to allow multiple selections
<caution>
Provide 2-5 concise, distinct options
<critical>
The default is to act. When ambiguity shows up, look at repo conventions, existing patterns, & reasonable defaults first — code, configs, docs, & history usually carry the answer. Save `ask` for the cases where options have materially different tradeoffs the user has to decide.
If multiple choices are acceptable, pick the most conservative/standard option & proceed; state the choice.
Don't include an "Other" option — the UI automatically adds "Other (type your own)" to every question.
<examples>
Single question
questions: [{"id": "auth_method", "question": "Which authentication method should this API use?", "options": [{"label": "JWT"}, {"label": "OAuth2"}, {"label": "Session cookies"}], "recommended": 0}]
Multiple questions
questions: [{"id": "storage_type", "question": "Which storage backend?", "options": [{"label": "SQLite"}, {"label": "PostgreSQL"}]}, {"id": "auth_method", "question": "Which auth method?", "options": [{"label": "JWT"}, {"label": "Session cookies"}]}]