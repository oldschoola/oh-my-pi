Launches subagents to parallelize workflows.
{{#if asyncEnabled}}
Results are delivered automatically when complete.
The tool result lists the assigned task ids (e.g. `0-AuthLoader`) — those are the live agent ids.
{{#if ircEnabled}}
Coordinate with running tasks via `irc` using those ids. `job cancel` terminates a task & cannot carry a message — only use it for stalled/abandoned work.
If genuinely blocked on completion, wait with `job poll`; otherwise keep working.
{{else}}
If genuinely blocked on completion, wait with `job poll`; otherwise keep working.
Use `job list` to snapshot manager state; `cancel: [id]` only to actually stop a stuck task.
{{/if}}
{{/if}}
{{#if ircEnabled}}
Subagents have no conversation history, but they can reach you & their siblings live via the `irc` tool. Front-load every fact, file path, & direction they need in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
{{else}}
Subagents have no conversation history. Every fact, file path, & direction they need has to be explicit in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}} — they have no other channel.
{{/if}}
<parameters>
`agent`: agent type for all tasks
`tasks`: tasks to execute in parallel
- `.id`: CamelCase, ≤32 chars
- `.description`: UI label only — subagent never sees it
- `.assignment`: complete self-contained instructions; one-liners & missing acceptance criteria don't give the subagent enough to act on
{{#if contextEnabled}}- `context`: shared background prepended to every assignment; session-specific only{{/if}}
{{#if customSchemaEnabled}}- `schema`: JTD schema for expected structured output (do not put format rules in assignments){{/if}}
{{#if isolationEnabled}}- `isolated`: run in isolated env; use when tasks edit overlapping files{{/if}}
<rules>
Don't assign project-wide build/test/lint to subagents. The caller verifies after the batch — running it inside each task duplicates work & races.
Subagents don't verify, lint, or format. Tell them so explicitly in the assignment. Run gates & formatters once at the end across the union of changed files — that avoids redundant runs & racing formatter passes.
{{#if ircEnabled}}
Each task: ≤3-5 explicit files. Overlapping file sets are tolerable when peers can coordinate via `irc`, but still fan out to a cluster when the scopes are cleanly separable.
No globs, no "update all", no package-wide scope.
{{else}}
Fan out to a cluster instead.
{{/if}}
Pass large payloads via `local://<path>` URIs, not inline.
{{#if contextEnabled}}- Put shared constraints in `context` once; don't duplicate across assignments.{{/if}}
Prefer agents that investigate & edit in one pass; only spin a read-only discovery step when affected files are genuinely unknown.
<parallelization>
{{#if ircEnabled}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B — unless B can reasonably ask A for the missing piece over `irc`. Live coordination beats a serial waterfall when the contract is small & easy to describe in a DM.
Still sequence when one task produces a large, evolving contract (generated types, schema migration, core module API) the other consumes wholesale — IRC round-trips don't replace a finished artifact.
Parallel when tasks touch disjoint files, are independent refactors/tests, or only need occasional clarification that can be resolved peer-to-peer.
{{else}}
If no, sequence A → B.
Sequential when one task produces a contract (types, API, schema, core module) the other consumes.
Parallel when tasks touch disjoint files or are independent refactors/tests.
{{/if}}
{{#if contextEnabled}}
<context-fmt>
Goal ← one sentence: what the batch accomplishes
Constraints ← MUST/NEVER rules & session decisions
Contract ← exact types/signatures if tasks share an interface
{{/if}}
<assignment-fmt>
Target ← exact files & symbols; explicit non-goals
Change ← step-by-step add/remove/rename; APIs & patterns
Acceptance ← observable result; no project-wide commands
<agents>
{{#if spawningDisabled}}
Agent spawning is disabled for this context.
{{else}}
{{#list agents join="\n"}}
{{name}}
{{description}}
{{/list}}
{{/if}}