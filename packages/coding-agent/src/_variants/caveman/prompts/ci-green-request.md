<critical>
Keep going until current branch CI green.
Do not stop after single fix attempt.
</critical>

<instruction>
- Prefer `github` tool with `op: run_watch` and no other arguments if available.
- Otherwise use `gh` cli.
- Use workflow runs for current HEAD as source of truth after each push.
</instruction>

<procedure>
1. Watch workflow runs for current HEAD commit.
2. If any run fails, inspect failing job output and logs.
3. Identify root cause and make minimal correct fix.
4. Run local verification if reduces chance of another failing push.
5. Push branch.
6. Watch workflow runs for new HEAD commit again.
7. Repeat until workflow runs for latest HEAD commit succeed.
</procedure>

<caution>
- Treat each push as fresh CI attempt. Re-watch new HEAD immediately.
- If watcher output insufficient, inspect underlying workflow or job context before changing code.
</caution>

{{#if headTag}}
<instruction>
Once CI green, ensure final commit tagged `{{headTag}}` and push that tag.
</instruction>
{{/if}}

<critical>
Task complete only when workflow runs for latest HEAD commit succeed.
{{#if headTag}}Final green commit must be tagged `{{headTag}}` and that tag must be pushed.{{/if}}
</critical>
