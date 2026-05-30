Run code in persistent kernel using list of cells.

<instruction>
Each call submits one or more cells. Cells run in array order. State persists within each language across cells, tool calls, and subagents spawned with `task`; variables parent or subagent declares visible to other on same shared executor.

Cell fields:

- `language` — {{#if py}}`"py"` for IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}`"js"` for persistent JavaScript VM{{/if}}.
- `code` — cell body, verbatim. Newlines, quotes, and indentation JSON-encoded; no fences, no headers.
- `title` (optional) — short label shown in transcript (e.g. `"imports"`, `"load config"`).
- `timeout` (optional) — per-cell timeout in seconds (1-600). Default 30.
- `reset` (optional) — wipe this cell's language kernel before running.{{#ifAll py js}} Reset is per-language: `py` cell's reset does not touch JavaScript VM and vice versa.{{/ifAll}}

**Work incrementally:**

- One logical step per cell (imports, define, test, use).
- Pass multiple small cells in one call.
- Define small reusable functions for individual debugging.
- Put workflow explanations in assistant message or `title` — never inside cell code.
{{#if py}}- Python cells run inside IPython kernel with live event loop. Use top-level `await` directly (e.g. `await main()`); `asyncio.run(…)` raises "cannot be called from a running event loop".{{/if}}
**On failure:** errors identify failing cell (e.g., "Cell 3 failed"). Resubmit only fixed cell (or fixed cell + remaining cells).
</instruction>

<prelude>
{{#ifAll py js}}Same helpers in both runtimes with same positional argument order. Python: trailing options as keyword args. JavaScript: trailing options as trailing object literal. JavaScript helpers are async and `await`able; Python helpers run synchronously.{{else}}{{#if py}}Helpers run synchronously. Trailing options are keyword arguments.{{/if}}{{#if js}}Helpers are async and `await`able. Trailing options are final object literal.{{/if}}{{/ifAll}}
```
display(value) → None
    Render a value in the current cell output.
print(value, ...) → None
    Print to the cell's text output.
read(path, offset?=1, limit?=None) → str
    Read file contents as text. offset/limit are 1-indexed line bounds.
write(path, content) → str
    Write content to a file (creates parent directories). Returns the resolved path.
append(path, content) → str
    Append content to a file. Returns the resolved path.
tree(path?=".", max_depth?=3, show_hidden?=False) → str
    Render a directory tree.
diff(a, b) → str
    Unified diff between two files.
env(key?=None, value?=None) → str | None | dict
    No args → full environment as dict. One arg → value of `key`. Two args → set `key=value` and return value.
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
    Read task/agent output by ID. Single id returns text/dict; multiple ids return a list.
tool.<name>(args) → unknown
    Invoke any session tool by name. `args` is the tool's parameter object.
```
</prelude>

<output>
Cells render like Jupyter notebook. `display(value)` renders non-presentable data as interactive JSON tree. Presentable values (figures, images, dataframes, etc.) use native representation.
</output>

<caution>
{{#if js}}- **js**: VM exposes selective `process` subset, Web APIs, `Buffer`, `fs/promises`, and `Bun` global.
{{/if}}</caution>

<example>
{{#if py}}```json
{
  "cells": [
    { "language": "py", "title": "imports", "timeout": 10, "code": "import json\nfrom pathlib import Path" },
    { "language": "py", "title": "load config", "code": "data = json.loads(read('package.json'))\ndisplay(data)" }
  ]
}
```{{/if}}{{#ifAll py js}}

{{/ifAll}}{{#if js}}```json
{
  "cells": [
    { "language": "js", "title": "summary", "reset": true, "code": "const data = JSON.parse(await read('package.json'));\ndisplay(data);\nreturn data.name;" }
  ]
}
```{{/if}}
</example>
