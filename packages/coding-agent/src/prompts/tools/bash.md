Executes bash command in shell session for terminal operations like git, bun, cargo, python.

<instruction>
- Use `cwd` to set working directory rather than `cd dir && …`
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values; reference as `$NAME`
- Quote variable expansions like `"$NAME"` to preserve exact content
- PTY mode is opt-in: set `pty: true` only when the command needs a real terminal (e.g. `sudo`, `ssh` requiring user input); default is `false`
- Use `;` only when later commands should run regardless of earlier failures
- Internal URIs (`skill://`, `agent://`, etc.) are auto-resolved to filesystem paths
{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you don't need immediate output; the call returns a background job ID and the result is delivered automatically as a follow-up.
{{/if}}
</instruction>

<critical>
- When a dedicated tool fits (`read`, `search`, `find`, `edit`, `write`), reach for it instead of shelling out to coreutils (`cat`, `head`, `tail`, `less`, `more`, `ls`, `grep`, `rg`, `awk`, `sed`, `find`, `fd`, …). The dedicated tools keep gitignore semantics, paginate predictably, and emit the headers other tools depend on.
- No need to pipe through `| head -n N` or `| tail -n N` — output is already truncated, and the full result is available via `artifact://<id>`.
- Skip `2>&1` or `2>/dev/null` — stdout and stderr are already merged here.
</critical>

<output>
- Returns output and exit code.
- Truncated output is retrievable from `artifact://<id>` (linked in metadata)
- Exit codes shown on non-zero exit
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` (seconds) caps the **wall-clock duration** of the command. When it elapses the process is killed and the call returns with a timeout annotation. Range: `1`–`3600`s; default `300`s (see `clampTimeout("bash", …)` in `tool-timeouts.ts`).
- `async: true` only defers **reporting** of the result — it does NOT disable, extend, or detach the timeout. A daemon started with `async: true` is still killed when `timeout` elapses, regardless of how long the agent waits before reading the result.
- For long-running daemons (dev servers, watchers): either pass an explicit large `timeout` (up to `3600`), or fully detach the process from this shell using `nohup …  &` / `setsid … &` / `disown` so it survives independent of the bash call's lifecycle.
{{/if}}

# Output minimizer

- Bash stdout/stderr may be rewritten before you see it: long output is head/tail truncated, and test/lint runners (e.g. `bun test`, `cargo test`, ESLint) are passed through heuristic filters that drop noise and keep failures.
- When the minimizer changes the visible text, the tool appends a `[raw output: artifact://<id>]` footer pointing at the **full untouched capture**. If a run looks suspicious (e.g. only a version banner) or you need the exact bytes, read that artifact.
- If no footer is present, what you see is what the command actually emitted.
