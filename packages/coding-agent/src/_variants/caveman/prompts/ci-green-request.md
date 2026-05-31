{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
<critical>
Keep going until the current branch CI is green. A single fix attempt usually isn't enough — iterate.
<instruction>
Prefer the `github` tool with `op: run_watch` & no other arguments when available.
Otherwise use the `gh` CLI.
Use workflow runs for current HEAD as the source of truth after each push.
<procedure>
Watch workflow runs for the current HEAD commit.
If any run fails, inspect the failing job output & logs.
Identify the root cause & make the minimal correct fix.
Run local verification when it would reduce the chance of another failing push.
Push the branch.
Watch workflow runs for the new HEAD commit again.
Repeat until workflow runs for the latest HEAD commit succeed.
<caution>
Treat each push as a fresh CI attempt. Re-watch new HEAD immediately.
If watcher output is insufficient, inspect the underlying workflow or job context before changing code.
{{#if headTag}}
Once CI is green, ensure the final commit is tagged `{{headTag}}` & push that tag.
{{/if}}
The task is complete only when the workflow runs for the latest HEAD commit succeed.
{{#if headTag}}The final green commit needs to be tagged `{{headTag}}` & that tag pushed.{{/if}}