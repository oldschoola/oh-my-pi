Call this FIRST for any codebase-retrieval question (where is / find / list / is there X, dead code, unused refs) — before `search`/`find`/`read`/`bash` or spawning subagents. Returns a ranked file shortlist with inline code snippets in seconds.

Treat this as your default first step for any code comprehension task: understanding code before editing, tracing logic across modules, answering "how does X work?" or "where is Y defined?", mapping dependencies, or assessing impact.

## Trust the results — don't re-search

After fast_context returns, trust its listing and snippets. The result includes inline code snippets (keyword-matched context) for the top files — in most cases this is sufficient to answer the user's question or proceed with edits directly, WITHOUT calling `read` on the same files.

- **Don't repeat searches.** Do not run `search`/`find`/`grep` across the repo for the same information fast_context already found. Every re-search wastes a turn.
- **Re-ask, don't re-search.** If fast_context's results feel incomplete or you're unsure where to look next, call `fast_context` again with a sharper, more specific query — re-asking is faster and more accurate than manual repo scanning.
- **Read narrowly, only when needed.** Only call `read` if you need context beyond the snippets (e.g. full function body, imports, surrounding type definitions, or the snippet was truncated). Use a narrow line range, not the whole file.
- **Use `search`/`find` only for known files.** Reserve manual `search` for when you already know the exact file or 2-3 files to look in.

## When NOT to use

- You already read the exact file this session
- Single obvious `search` in one known file (e.g. a specific class definition)
- Pure write/generate task with zero exploration needed

## Configuration

Mode and snippets are set by the `fastContext.mode` (hint | agent) and `fastContext.snippets` settings — OMIT the `mode` and `include_snippets` parameters so your configured settings apply. `fastContext.fastTools` forces agent mode (SWE-grep-style parallel Read/Glob/Grep, ≤4 turns) for thorough retrieval.

Modes:
- `hint` (default): one model turn → keywords/globs/grep, then native ripgrep/glob (~2-5s). Returns candidate files with snippets directly.
- `agent`: full multi-turn Read/Glob/Grep loop with `<final_answer>` citations (~20-40s, more thorough).

If it returns no files or clearly insufficient results, fall back to normal `search`, `find`, and `read`.
