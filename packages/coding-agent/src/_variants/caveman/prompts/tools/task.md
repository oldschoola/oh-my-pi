Launches subagents to parallelize workflows.

{{#if asyncEnabled}}
- Results delivered automatically when complete.
- Tool result lists assigned task ids (e.g. `0-AuthLoader`) — those are live agent ids.
{{#if ircEnabled}}
- Coordinate with running tasks via `irc` using those ids. `job cancel` terminates task and **cannot carry message** — only use it for stalled/abandoned work.
- If genuinely blocked on completion, wait with `job poll`; otherwise keep working.
{{else}}
- If genuinely blocked on completion, wait with `job poll`; otherwise keep working.
- Use `job list` to snapshot manager state; `cancel: [id]` only to actually stop stuck task.
{{/if}}
{{/if}}

{{#if ircEnabled}}
Subagents have no conversation history, but they can reach you and their siblings live via `irc` tool. Front-load every fact, file path, and direction they need in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
{{else}}
Subagents have no conversation history. Every fact, file path, and direction they need MUST be explicit in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
{{/if}}

<parameters>
- `agent`: agent type for all tasks
- `tasks`: tasks to execute in parallel
 - `.id`: CamelCase, ≤32 chars
 - `.description`: UI label only — subagent never sees it
 - `.assignment`: complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
{{#if contextEnabled}}- `context`: shared background prepended to every assignment; session-specific only{{/if}}
{{#if customSchemaEnabled}}- `schema`: JTD schema for expected structured output (do not put format rules in assignments){{/if}}
{{#if isolationEnabled}}- `isolated`: run in isolated env; use when tasks edit overlapping files{{/if}}
</parameters>

<rules>
- NEVER assign tasks to run project-wide build/test/lint. Caller verifies after batch.
- **Subagents do not verify, lint, or format.** Every assignment MUST instruct subagent to skip all gates and formatters. You run them once at end across union of changed files — avoids redundant runs and racing formatter passes.
{{#if ircEnabled}}
- Each task: ≤3–5 explicit files. Overlapping file sets tolerable when peers can coordinate via `irc`, but still fan out to cluster when scopes cleanly separable.
- No globs, no "update all", no package-wide scope.
{{else}}
- Each task: ≤3–5 explicit files. No globs, no "update all", no package-wide scope. Fan out to cluster instead.
{{/if}}
- Pass large payloads via `local://<path>` URIs, not inline.
{{#if contextEnabled}}- Put shared constraints in `context` once; do not duplicate across assignments.{{/if}}
- Prefer agents that investigate **and** edit in one pass; only spin read-only discovery step when affected files genuinely unknown.
</rules>

<parallelization>
{{#if ircEnabled}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B — **unless** B can reasonably ask A for missing piece over `irc`. Live coordination beats serial waterfall when contract small and easy to describe in DM.
Still sequence when one task produces large, evolving contract (generated types, schema migration, core module API) other consumes wholesale — IRC round-trips do not replace finished artifact.
Parallel when tasks touch disjoint files, are independent refactors/tests, or only need occasional clarification that can be resolved peer-to-peer.
{{else}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B.
Sequential when one task produces contract (types, API, schema, core module) other consumes.
Parallel when tasks touch disjoint files or are independent refactors/tests.
{{/if}}
</parallelization>

{{#if contextEnabled}}
<context-fmt>
# Goal         ← one sentence: what the batch accomplishes
# Constraints  ← MUST/NEVER rules and session decisions
# Contract     ← exact types/signatures if tasks share an interface
</context-fmt>
{{/if}}

<assignment-fmt>
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands
</assignment-fmt>

<agents>
{{#if spawningDisabled}}
Agent spawning disabled for this context.
{{else}}
{{#list agents join="\n"}}
# {{name}}
{{description}}
{{/list}}
{{/if}}
</agents>
