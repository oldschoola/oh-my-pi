{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
Code Review Request
Mode
{{mode}}
Changed Files ({{len files}} files, +{{totalAdded}}/-{{totalRemoved}} lines)
{{#if files.length}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{else}}
_No files to review._
{{/if}}
{{#if excluded.length}}
Excluded Files ({{len excluded}})
{{#list excluded prefix="- " join="\n"}}
`{{path}}` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}
Distribution Guidelines
Use the `task` tool with `agent: "reviewer"` & a `tasks` array.
{{#when agentCount "==" 1}}Create exactly 1 reviewer task.{{else}}Spawn {{agentCount}} reviewer agents in parallel.{{/when}}
{{#if multiAgent}}
Group files by locality, e.g.:
Same directory/module → same agent
Related functionality → same agent
Tests with their implementation files → same agent
{{/if}}
Reviewer Instructions
Each reviewer:
Focuses only on assigned files
{{#if skipDiff}}Runs `git diff`/`git show` for assigned files{{else}}Uses the diff hunks below (don't re-run git diff — that loses the canonical view){{/if}}
May read full file context as needed via `read`
Calls `report_finding` per issue
Calls `yield` with the verdict when done
{{#if skipDiff}}
Diff Previews
_Full diff too large ({{len files}} files). Showing first ~{{linesPerFile}} lines per file._
{{#list files join="\n\n"}}
{{path}}
{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}
Diff
{{rawDiff}}
{{/if}}
{{#if additionalInstructions}}
more Instructions
{{additionalInstructions}}
{{/if}}