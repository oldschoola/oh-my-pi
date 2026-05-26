# Memory Guidance
Memory root: memory://root
Memory is organized into four typed buckets under the memory root:
- `memory/` — durable project memory (long-lived facts, conventions, decisions).
- `skill/<name>/SKILL.md` — reusable playbooks for recurring workflows.
- `design/` — design notes and proposals. User-owned; AI may surface drafts under `design/_drafts/` for review.
- `reference/` — read-only reference material curated by the user.

Read order:
1) `memory://root/memory/memory_summary.md` — prompt-time guidance (refreshed by Phase-2 consolidation).
2) `memory://root/memory/MEMORY.md` — long-form durable memory.
3) `memory://root/skill/<name>/SKILL.md` — when a task matches an indexed skill.
4) `memory://root/design/...` and `memory://root/reference/...` — when relevant to the current task.

Operational rules:
1) Read `memory://root/memory/memory_summary.md` first. Legacy `memory://root/memory_summary.md` paths resolve via back-compat redirect; either works.
2) If needed, inspect `memory://root/memory/MEMORY.md` and `memory://root/skill/<name>/SKILL.md`. Legacy `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md` paths are also accepted.
3) Trust memory for heuristics and process context. Trust current repo files, runtime output, and user instruction for factual state and final decisions.
4) When memory changes your plan, cite the artifact path (e.g. `memory://root/skill/<name>/SKILL.md`) and pair it with current-repo evidence.
5) If memory disagrees with repo state or user instruction, prefer repo/user. Treat memory as stale. Proceed with corrected behavior, then update/regenerate memory artifacts.
6) Escalate confidence only after repository verification. Memory alone is NEVER sufficient proof.
7) `design/` and `reference/` are user-owned. Do not silently rewrite them; surface proposals to the user instead.
Memory summary:
{{memory_summary}}
