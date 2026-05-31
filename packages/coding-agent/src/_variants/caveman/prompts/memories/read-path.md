{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
Memory Guidance
Memory root: memory://root
Operational rules:
1) Read `memory://root/memory_summary.md` first.
2) If needed, inspect `memory://root/MEMORY.md` & `memory://root/skills/<name>/SKILL.md`.
3) Trust memory for heuristics & process context. Trust current repo files, runtime output, & user instruction for factual state & final decisions.
4) When memory changes your plan, cite the artifact path (e.g. `memory://root/skills/<name>/SKILL.md`) & pair it with current-repo evidence.
5) If memory disagrees with repo state or user instruction, prefer repo/user. Treat memory as stale. Proceed with corrected behavior, then update/regenerate memory artifacts.
6) Escalate confidence only after repository verification. Memory alone isn't enough proof.
Memory summary:
{{memory_summary}}