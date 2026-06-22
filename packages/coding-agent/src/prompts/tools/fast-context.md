Call this FIRST for any codebase-retrieval question (where is / find / list / is there X, dead code, unused refs) — before `search`/`find`/`read`/`bash` or spawning subagents. Returns a ranked file shortlist in seconds, then `read` the top hits.

Delegates repository exploration to a local FastContext model.

Mode and snippets are set by the `fastContext.mode` (hint | agent) and `fastContext.snippets` settings — OMIT the `mode` and `include_snippets` parameters so your configured settings apply.

Modes:
- `hint` (default): one model turn → keywords/globs/grep, then native ripgrep/glob (~2-5s). Returns candidate files directly.
- `agent`: full multi-turn Read/Glob/Grep loop with `<final_answer>` citations (~20-40s, more thorough).

If it returns insufficient files, continue with normal `search`, `find`, and `read`.
