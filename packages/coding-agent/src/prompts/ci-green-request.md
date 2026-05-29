<critical>
Keep going until the current branch CI is green. A single fix attempt usually isn't enough — iterate.
</critical>

<instruction>
- Prefer the `github` tool with `op: run_watch` and no other arguments when available.
- Otherwise use the `gh` CLI.
- Use workflow runs for current HEAD as the source of truth after each push.
</instruction>

<procedure>
1. Watch workflow runs for the current HEAD commit.
2. If any run fails, inspect the failing job output and logs.
3. Identify the root cause and make the minimal correct fix.
4. Run local verification when it would reduce the chance of another failing push.
5. Push the branch.
6. Watch workflow runs for the new HEAD commit again.
7. Repeat until workflow runs for the latest HEAD commit succeed.
</procedure>

<caution>
- Treat each push as a fresh CI attempt. Re-watch new HEAD immediately.
- If watcher output is insufficient, inspect the underlying workflow or job context before changing code.
</caution>

{{#if headTag}}
<instruction>
Once CI is green, ensure the final commit is tagged `{{headTag}}` and push that tag.
</instruction>
{{/if}}

<critical>
The task is complete only when the workflow runs for the latest HEAD commit succeed.
{{#if headTag}}The final green commit needs to be tagged `{{headTag}}` and that tag pushed.{{/if}}
</critical>
