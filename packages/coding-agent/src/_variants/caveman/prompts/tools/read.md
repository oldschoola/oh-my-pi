Read files, directories, archives, SQLite databases, images, documents, internal resources, & web URLs through a single `path` string.
<instruction>
One tool for filesystem, archives, SQLite, images, documents (PDF/DOCX/PPTX/XLSX/RTF/EPUB/ipynb), internal URIs, & web URLs (reader-mode by default).
Parallelize independent reads when exploring related files — that's how `read` is meant to be used.
For web content, reach for `read` first; a browser/puppeteer tool is heavier & rarely what the task actually needs.
Parameters
`path` — required. Local path, internal URI (`skill://`, `agent://`, `artifact://`, `memory://`, `rule://`, `local://`, `vault://`, `mcp://`), or URL. Append `:<sel>` for line ranges, raw mode, or special modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).
Selectors
Append `:<sel>` to `path`. The bare path falls back to the default mode.
_(none)_ — parseable code → structural summary (signatures kept, bodies elided); other files → read from the start (up to {{DEFAULT_LIMIT}} lines).
`:50` / `:50-` — read from line 50 onward.
`:50-200` — lines 50-200 inclusive.
`:50+150` — 150 lines starting at line 50.
`:20+1` — exactly one line.
`:5-16,960-973` — multiple ranges in one call (sorted, overlaps merged).
`:raw` — verbatim text; no anchors, no summary, no line prefixes.
`:2-4:raw` or `:raw:2-4` — range & verbatim; the two compose in either order.
`:conflicts` — one-line-per-block index of every unresolved git merge conflict.
Files
Reading a directory path returns a depth-limited dirent listing.
{{#if IS_HL_MODE}}
Reading a file with an explicit selector emits a file snapshot tag header & numbered lines: `¶src/foo.ts#0a` then `41:def alpha():`. Copy the `¶PATH#TAG` header for anchored edits; ops use bare line numbers. The tag comes from the read — don't fabricate one.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
Reading a file with an explicit selector returns lines prefixed with line numbers: `41|def alpha():`.
{{/if}}
{{/if}}
Parseable code without a selector returns a structural summary: declarations kept, large bodies collapsed to `..` (merged brace pair) or `…` (standalone). Summarized output ends with a footer demonstrating the multi-range selector you can use to recover the elided bodies, e.g.:
`[NN lines elided; re-read needed ranges, e.g. <path>:5-16,40-80]`
Re-issue only the relevant range(s) using the multi-range selector (e.g. `<path>:5-16,120-200`). The `..` / `…` markers carry no content — re-read for the actual bytes rather than guessing. When a targeted range will do, prefer it over re-reading the whole file or using `:raw`.
Documents & Notebooks
Extracts text from PDF, Word, PowerPoint, Excel, RTF, & EPUB. Notebooks (`.ipynb`) are shown as editable `# %% [type] cell:N` text; edits round-trip back to the underlying JSON preserving notebook metadata. Add `:raw` to a notebook to bypass the converter & read the JSON directly.
Images
Reading an image path returns metadata (mime, bytes, dimensions, channels, alpha). For actual visual analysis, call `inspect_image` with the path & a question describing what to inspect.
Archives
Supports `.tar`, `.tar.gz`, `.tgz`, `.zip`. Use `archive.ext:path/inside/archive` to read a member, & append a normal selector to the inner path: `archive.zip:dir/file.ts:50-60`.
SQLite
For `.sqlite`, `.sqlite3`, `.db`, `.db3`:
`file.db` — list tables with row counts
`file.db:table` — schema + sample rows
`file.db:table:key` — single row by primary key
`file.db:table?limit=50&offset=100` — paginated rows
`file.db:table?where=status='active'&order=created:desc` — filtered rows
`file.db?q=SELECT …` — read-only SELECT query
URLs
Default reader-mode: HTML pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs → clean text/markdown.
`:raw` returns untouched HTML; line selectors (`:50`, `:50-100`, `:50+150`) paginate the cached fetched output.
Bare `host:port` URLs collide with the selector grammar — add a trailing slash before the selector: `https://example.com/:80`.
Internal URIs
`skill://<name>`, `agent://<id>`, `artifact://<id>`, `memory://root`, `rule://<name>`, `local://<name>.md`, `vault://<vault>/<path>`, `mcp://<uri>` resolve transparently & accept the same line selectors as filesystem paths. Use `artifact://<id>` to recover full output that a previous bash/eval/tool result spilled or truncated.
<critical>
`read` is the one path for files, directories, archives, & URL inspection. Shelling out via `cat`, `head`, `tail`, `less`, `more`, `ls`, `tar`, `unzip`, `curl`, `wget` skips the structural helpers (line headers, tag anchors, pagination, reader-mode) — convenient in the moment, lossy by the next turn.
For URL content, `read` is the right default; reach for a browser/puppeteer tool only when `read` can't return what you need.
Always include `path` — calling `read` with `{}` doesn't have a sensible meaning.
For line ranges, append the selector to `path` (`path="src/foo.ts:50-200"`, `path="src/foo.ts:50+150"`) rather than reaching for `sed -n`, `awk NR`, or `head`/`tail` pipelines. The selector keeps the file-tag header & numbered output, which the editing tools rely on.
When the summary footer says `read <path>:raw …`, re-issue the exact selector it names. Don't guess what's inside `..` / `…` — those markers carry no content.
Selectors compose with URL reads & internal URIs; both paginate the cached resolved output.