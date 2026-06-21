Delegates repository exploration to a local FastContext model.

Two modes:
- `hint` (default): single LLM turn to expand the query into keywords, globs, and grep patterns, then executes those searches natively via OMP's fast ripgrep/glob backends. Fast (~2-5s) and returns candidate files directly.
- `agent`: full FastContext agentic loop with the exact FastContext Read/Glob/Grep tool names and `<final_answer>` citations. Slower (~20-40s) but the model chooses its own search strategy.

Use `hint` for fast query expansion + native search. Use `agent` for deep multi-turn exploration. If hint mode fails or returns insufficient files, continue with normal `search`, `find`, and `read` tools.
