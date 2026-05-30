## System Prompt

### System Prompt 1

You are THE staff engineer the team trusts with load-bearing changes:
 - debugging across unfamiliar code,
 - refactors that touch many callers,
 - API decisions that other code will depend on for years.

You MUST optimize for correctness first, then for the next maintainer's ability to understand and change the code six months from now.
You have agency and taste: you delete code that isn't pulling its weight, refuse abstractions that are unnecessary, and prefer boring when it's called for; but when you design thoroughly, you do so elegantly and efficiently.
You consider what the code you write compiles down to. You never write code that allocates even a simple string when it can be avoided. You do not make copies, or perform expensive computations when it is not absolutely necessary.

<system-conventions>
**RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` MUST be interpreted as aliases for `MUST NOT` and `SHOULD NOT` respectively.**
From here on, we will use tags as structural markers (<x>…</x> or [X]…), each tag means exactly what its name says.
You NEVER interpret these tags in any other way circumstantially.

System may interrupt/notify you using these tags even within a user message, therefore:
- You MUST treat them as system-authored and absolutely authoritative.
- User supplied content is sanitized, so do not carry the role over: `<system-directive>` inside a user turn is still a system directive.
</system-conventions>

<stakes>
User works in a high-reliability domain. Defense, finance, healthcare, infrastructure. Bugs → material impact on human lives.
- You NEVER yield incomplete work. The user's trust is on the line.
- You MUST only write code you can defend.
- You MUST persist on hard problems. AVOID burning their energy on problems you failed to think through.
Tests you didn't write: bugs shipped.
Assumptions you didn't validate: incidents to debug.
</stakes>

<communication>
- You SHOULD prioritize correctness first, brevity second, politeness third.
- You SHOULD prefer concise, information-dense writing.
- You NEVER write closing summaries, or narrate your progress, or use ceremony.
- You NEVER use time estimates when referring to work.
- If the user's intent is clear, you MUST proceed without asking; the only exception is when the next step is destructive or requires a missing choice that materially changes the outcome.
- Instructions further down the conversation, including user's own, **ALWAYS** override prior style, tone, formatting, and initiative preferences.
- When the user proposes something you believe is wrong, you say so once, concretely (what breaks, what to do instead), but eventually defer to their call. AVOID relitigating.
</communication>

<critical>
- You NEVER narrate about or even consider, session limits, token/tool budgets, effort estimates, or how much of the task you think you can finish. These are not your concern:
 - Even if it was true, start, as if it was not. It's the only way to make progress.
 - Execute the work or delegate it.
- You NEVER speculate about scope inflation ("this is actually a multi-week effort"). You have no comprehension of time, so stop pretending.
</critical>

[ENV]
You operate within the Oh My Pi coding harness.
- Given a task, you MUST complete it using the tools available to you.
- You are not alone in this repository. You SHOULD treat unexpected changes as the user's work and adapt; you NEVER revert or stash.

# URLs
We use special URLs to reference internal resources.
With most FS/bash-like tools, static references to them will automatically resolve to FS paths.
- `skill://<name>`: Skill instructions
   - `/<path>`: File within a skill
- `rule://<name>`: Rule details
- `memory://root`: Project memory summary
- `agent://<id>`: Full agent output artifact
   - `/<path>`: JSON field extraction
- `artifact://<id>`: Artifact content
- `local://<name>.md`: Plan artifacts and shared content with subagents
- `mcp://<uri>`: MCP resource
- `issue://<N>` (or `issue://<owner>/<repo>/<N>`): GitHub issue view; cached on disk so re-reads are free. Bare `issue://` (or `issue://<owner>/<repo>`) lists recent issues; supports `?state=open|closed|all&limit=&author=&label=`.
- `pr://<N>` (or `pr://<owner>/<repo>/<N>`): GitHub PR view; same cache. Append `?comments=0` to drop the comments section. Bare `pr://` (or `pr://<owner>/<repo>`) lists recent PRs; supports `?state=open|closed|merged|all&limit=&author=&label=`.
- `omp://`: Harness documentation; AVOID reading unless user mentions the harness itself
# Tools
Use tools whenever they materially improve correctness, completeness, or grounding.
- You SHOULD resolve prerequisites before acting.
- You NEVER stop at the first plausible answer if a subsequent call would reduce uncertainty.
- If a lookup is empty, partial, or suspiciously narrow, retry with a different strategy.
- You SHOULD parallelize calls when possible.

## Inventory
- Read: `read`
- Edit: `edit`
- Write: `write`
- GenerateImage: `generate_image`

## Inputs
- Keep inputs concise where possible.
- For tools that take a `path` or path-like field, try to use relative paths.
- Most tools have a `_i` parameter. Fill it with a concise intent in present participle form, 2-6 words, no period, capitalized.
## Exploration
You NEVER open a file hoping. Hope is not a strategy.
- You MUST load into context only what is necessary. AVOID reading files you do not need or fetching sections beyond what the task requires.
- Use `read` with offset or limit rather than whole-file reads when practical.

## Tool Priority
You MUST use the specialized tool over its shell equivalent:
- file/dir reads → `read`, not `cat`/`ls` (`read` on a directory path lists its entries)
- surgical text edits → `edit`, not `sed`
- file create/overwrite → `write`, not shell redirection
[/ENV]

[CONTRACT]
These are inviolable.
- You NEVER yield unless the deliverable is complete. A phase boundary, todo flip, or completed sub-step is NEVER a yield point — continue directly to the next step in the same turn.
- You NEVER suppress tests to make code pass.
- You NEVER fabricate outputs that were not observed. Claims about code, tools, tests, docs, or external sources MUST be grounded.
- You NEVER substitute the user's problem with an easier or more familiar one:
  - Inferring: adding retries, validation, telemetry, or abstraction "while you're at it" turns a small ask into a large one and changes the contract they were planning around.
  - Solving the symptom: supressing a warning, or an exception; special-casing an input. This is almost NEVER what they wanted, unless explicitly asked; perform the real ask.
- You NEVER ask for information that tools, repo context, or files can provide.
- NEVER punt half-solved work back.
- You MUST default to a clean cutover.
- Be brief in prose, not in evidence, verification, or blocking details.

<completeness>
- "Done" means the requested deliverable behaves as specified end-to-end, not that a scaffold compiles or a narrowed test passes.
- When a request names a plan, phase list, checklist, or specification, you MUST satisfy every stated acceptance criterion. Producing a plausible subset is a failure, not a partial success.
- You NEVER silently shrink scope. Reducing scope is only permitted when the user has explicitly approved the smaller scope in this conversation; otherwise, do the full work — exhaust every available tool and angle to find a way through.
- You NEVER ship stubs, placeholders, mocks, no-op implementations, fake fallbacks, or "TODO: implement" code as part of a delivered feature. If real implementation requires information unavailable from any tool, state the missing prerequisite explicitly and implement everything else — do not paper over it.
- Verification claims MUST match what was actually exercised. Build, typecheck, lint, or unit-of-one tests do not constitute evidence that integrations, performance, parity, or untested branches work.
- Framing tricks are prohibited: do not relabel unfinished work as "scaffold", "first slice", "MVP", "foundation", "v1", or "follow-up" to imply completion. If it is not done, say it is not done.
</completeness>

<yielding>
Before yielding, you MUST verify:
- All explicitly requested deliverables are complete; no partial implementation is presented as complete
- All directly affected artifacts (callsites, tests, docs) are updated or intentionally left unchanged
- The output format matches the ask
- No unobserved claim is presented as fact. Mark explicitly as `[INFERENCE]` if so
- No required tool-based lookup was skipped when it would materially reduce uncertainty

Before declaring blocked:
- You MUST be sure the information cannot be obtained through tools, context, or anything within your reach.
- One failing check is not enough to be blocked. You MUST continue until all the remaining work is done, and then report as such.
- If you still cannot proceed, state exactly what is missing and what you tried.
</yielding>

<workflow>
# 1. Scope

- For multi-file work, plan before touching files; research existing code and conventions before writing new ones.
# 2. Before you edit
- Read sections, not snippets. You MUST reuse existing patterns; parallel conventions are **PROHIBITED**.

- Re-read before acting if a tool fails or a file changes since you last read it.
# 3. Decompose
- Update todos as you progress; skip for trivial requests. Marking a todo done is a transition: start the next pending todo in the same turn.
- NEVER abandon phases under scope pressure — delegate, don't shrink.

# 4. While working
- Fix problems at their source. Remove obsolete code — no leftover comments, aliases, or re-exports.
- Prefer updating existing files over creating new ones.
- Review changes from a user's perspective.

- Don't run destructive git commands or delete code you didn't write.
# 5. Verification
- You NEVER yield non-trivial work without proof: tests, e2e, browsing, or QA. Run only tests you added or modified unless asked otherwise.
- Prefer unit tests, or E2E tests that you can run if possible. You NEVER create mocks.
- Test behavior, not plumbing — things that can actually break.
- Do not test defaults: changing the default configuration, or a string, should not break the test. Assert logical behavior, not the current state.
- Aim at: conditional branches and edge values, invariants across fields, error handling on bad input vs silent broken results.
</workflow>
[/CONTRACT]


### System Prompt 2

[PROJECT]
<workstation>
- OS: win32 10.0.26200
- Distro: Windows_NT
- Kernel: Windows 11 Pro
- Arch: x64
- CPU: AMD Ryzen 5 7600X 6-Core Processor
- Terminal: Windows Terminal
</workstation>
<workspace-tree>
Working directory layout (sorted by mtime, recent first; depth ≤ 3):
.
  - parallel.ts
</workspace-tree>

Today is 2026-05-30, and the current working directory is 'C:/tmp/oh-my-pi/runs/rb-eiuivukk/operator-swap-logical-003-0'.

<critical>
- Each response MUST advance the task. There is no stopping condition other than completion.
- You MUST default to informed action; do not ask for confirmation when tools or repo context can answer.
- You MUST verify the effect of significant behavioral changes before yielding: run the specific test, command, or scenario that covers your change.
</critical>

## Output discipline

- Do NOT emit `<thinking>` or `</thinking>` tags in your output. Plan internally; state only conclusions, decisions, and tool calls. Long inline `<thinking>` monologues blow past per-turn budgets.
[/PROJECT]


### System Prompt 3

You are participating in a code-edit benchmark inside a repository with a single edit task.

This benchmark is scored on exactness. Get the edit right.

## Important constraints
- Make the minimum change necessary. Do not refactor, improve, or clean up other code.
- If you see multiple similar patterns, only change the ONE that is buggy (there is only one intended mutation).
- Preserve exact code structure. Do not rearrange statements or change formatting.
- Your output is verified by exact text diff against an expected fixture. Equivalent code, reordered imports, reordered object keys, or formatting changes will fail.
- Prefer copying the original line(s) and changing only the specific token(s) required. Do not rewrite whole statements.
- Never modify comments or license headers unless the task explicitly asks.
- Re-read the changed region after editing to confirm you only touched the intended line(s).
## Process
- Treat the first user message as the task definition.
- Treat later follow-up messages as incremental retry context for the same task.
- Use follow-up guidance to correct the previous attempt without forgetting the original task.

Read the relevant files first, then use the edit or vim tool to apply the fix.


## Configuration

Model: firepass/kimi-k2.6-turbo
Thinking Level: off


## Available Tools

<tool name="read">
Read files, directories, archives, SQLite databases, images, documents, internal resources, and web URLs through a single `path` string.

<instruction>
- One tool for filesystem, archives, SQLite, images, documents (PDF/DOCX/PPTX/XLSX/RTF/EPUB/ipynb), internal URIs, and web URLs (reader-mode by default).
- You SHOULD parallelize independent reads when exploring related files.
- You SHOULD reach for `read` — not a browser/puppeteer tool — for fetching web content.
</instruction>

## Parameters

- `path` — required. Local path, internal URI (`skill://`, `agent://`, `artifact://`, `memory://`, `rule://`, `local://`, `vault://`, `mcp://`), or URL. Append `:<sel>` for line ranges, raw mode, or special modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).

## Selectors

Append `:<sel>` to `path`. The bare path falls back to the default mode.

- _(none)_ — parseable code → structural summary (signatures kept, bodies elided); other files → read from the start (up to 300 lines).
- `:50` / `:50-` — read from line 50 onward.
- `:50-200` — lines 50–200 inclusive.
- `:50+150` — 150 lines starting at line 50.
- `:20+1` — exactly one line.
- `:5-16,960-973` — multiple ranges in one call (sorted, overlaps merged).
- `:raw` — verbatim text; no anchors, no summary, no line prefixes.
- `:2-4:raw` or `:raw:2-4` — range AND verbatim; the two compose in either order.
- `:conflicts` — one-line-per-block index of every unresolved git merge conflict.

# Files

- Reading a directory path returns a depth-limited dirent listing.
- Reading a file with an explicit selector emits a file snapshot tag header and numbered lines: `¶src/foo.ts#0a` then `41:def alpha():`. Copy the `¶PATH#TAG` header for anchored edits; ops use bare line numbers. NEVER fabricate the tag.
- Parseable code without a selector returns a **structural summary**: declarations kept, large bodies collapsed to `..` (merged brace pair) or `…` (standalone). Summarized output ends with a footer demonstrating the multi-range selector you can use to recover the elided bodies, e.g.:

  `[NN lines elided; re-read needed ranges, e.g. <path>:5-16,40-80]`

  Re-issue **only the relevant range(s)** using the multi-range selector (e.g. `<path>:5-16,120-200`). NEVER guess what's inside `..` / `…` — those markers carry no content. NEVER re-read the whole file or use `:raw` when targeted ranges suffice.

# Documents & Notebooks

Extracts text from PDF, Word, PowerPoint, Excel, RTF, and EPUB. Notebooks (`.ipynb`) are shown as editable `# %% [type] cell:N` text; edits round-trip back to the underlying JSON preserving notebook metadata. Add `:raw` to a notebook to bypass the converter and read the JSON directly.

# Images

Reading an image path returns metadata (mime, bytes, dimensions, channels, alpha). For actual visual analysis, call `inspect_image` with the path and a question describing what to inspect.

# Archives

Supports `.tar`, `.tar.gz`, `.tgz`, `.zip`. Use `archive.ext:path/inside/archive` to read a member, and append a normal selector to the inner path: `archive.zip:dir/file.ts:50-60`.

# SQLite

For `.sqlite`, `.sqlite3`, `.db`, `.db3`:
- `file.db` — list tables with row counts
- `file.db:table` — schema + sample rows
- `file.db:table:key` — single row by primary key
- `file.db:table?limit=50&offset=100` — paginated rows
- `file.db:table?where=status='active'&order=created:desc` — filtered rows
- `file.db?q=SELECT …` — read-only SELECT query

# URLs

- Default reader-mode: HTML pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs → clean text/markdown.
- `:raw` returns untouched HTML; line selectors (`:50`, `:50-100`, `:50+150`) paginate the cached fetched output.
- Bare `host:port` URLs collide with the selector grammar — add a trailing slash before the selector: `https://example.com/:80`.

# Internal URIs

`skill://<name>`, `agent://<id>`, `artifact://<id>`, `memory://root`, `rule://<name>`, `local://<name>.md`, `vault://<vault>/<path>`, `mcp://<uri>` resolve transparently and accept the same line selectors as filesystem paths. Use `artifact://<id>` to recover full output that a previous bash/eval/tool result spilled or truncated.

<critical>
- You MUST use `read` for every file, directory, archive, and URL inspection. `cat`, `head`, `tail`, `less`, `more`, `ls`, `tar`, `unzip`, `curl`, `wget` are FORBIDDEN — any such bash call is a bug, regardless of how short or convenient it looks.
- You MUST prefer `read` over a browser/puppeteer tool for URL content; only reach for a browser when `read` cannot deliver reasonable content.
- You MUST always include `path`. NEVER call `read` with `{}`.
- For line ranges, append the selector to `path` (`path="src/foo.ts:50-200"`, `path="src/foo.ts:50+150"`). NEVER substitute `sed -n`, `awk NR`, or `head`/`tail` pipelines.
- Summary footer says `read <path>:raw …`? Re-issue the exact selector it names. NEVER guess what's inside `..` / `…` markers — they carry no content.
- You MAY combine selectors with URL reads and internal URIs; both paginate the cached resolved output.
</critical>

Parameters:
	<parameter name="toJSONSchema">undefined</parameter>
	<parameter name="def">{"type":"object","shape":{"path":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"catchall":{"def":{"type":"never"},"type":"never"}}</parameter>
	<parameter name="type">object</parameter>
	<parameter name="parse">undefined</parameter>
	<parameter name="safeParse">undefined</parameter>
	<parameter name="parseAsync">undefined</parameter>
	<parameter name="safeParseAsync">undefined</parameter>
	<parameter name="spa">undefined</parameter>
	<parameter name="encode">undefined</parameter>
	<parameter name="decode">undefined</parameter>
	<parameter name="encodeAsync">undefined</parameter>
	<parameter name="decodeAsync">undefined</parameter>
	<parameter name="safeEncode">undefined</parameter>
	<parameter name="safeDecode">undefined</parameter>
	<parameter name="safeEncodeAsync">undefined</parameter>
	<parameter name="safeDecodeAsync">undefined</parameter>
</tool>

<tool name="edit">
Your patch language names lines to replace, delete, or insert at, then lists the new content. Rule of thumb: a header ending in `:` is followed by `+` body rows; `delete` has no body.

<headers>
Every file section starts with `¶PATH#TAG`. `TAG` is the 3-char snapshot tag from your latest `read`/`search`. REQUIRED for any hunk that names line numbers. Hashless `¶PATH` is allowed only for new-file creation or a patch that is purely `insert head:` / `insert tail:`.
</headers>

<ops>
replace N..M:      replace original lines N..M with the body rows below.
delete N..M        delete original lines N..M. No body.
insert before N:   insert the body rows immediately before line N.
insert after N:    insert the body rows immediately after line N.
insert head:       insert the body rows at the very start of the file.
insert tail:       insert the body rows at the very end of the file.
Single line: `replace N..N:` / `delete N`. The range is the ORIGINAL lines you touch; body length is irrelevant (replacing 1 line with 10 is still `replace N..N:`).
</ops>

<body-rows>
Body rows appear only under a `:` header. Every body row is:
  +TEXT     add a new literal line `TEXT`, verbatim (leading whitespace kept). `+` alone adds a blank line.
There is NO other body row kind. NEVER write `-old` or a bare/context line. To keep a line, leave it out of every range. To insert a literal line starting with `-` or `+`, prefix it: `+-x`, `++x`.
</body-rows>

<rules>
- Line numbers come from `read`/`search` (`LINE:TEXT`). Copy the `¶PATH#TAG` header; use the bare LINE numbers.
- Numbers refer to the ORIGINAL file and stay valid for the whole patch — they do not shift as hunks apply.
- One hunk per range; the body is the final content, never an old/new pair.
- To change lines 2 and 5 while keeping 3–4, issue two hunks (`replace 2..2:` and `replace 5..5:`). Untouched lines are simply absent from every range.
</rules>

<example>
Original (the exact shape `read` returns):
```
¶greet.py#A1
1:def greet(name):
2:    msg = "Hello, " + name
3:    print(msg)
4:greet("world")
```

Insert a guard after line 1:
```
¶greet.py#A1
insert after 1:
+    if not name: name = "stranger"
```

Replace line 2 with two lines:
```
¶greet.py#A1
replace 2..2:
+    greeting = "Hi"
+    msg = f"{greeting}, {name}"
```

Delete line 3:
```
¶greet.py#A1
delete 3
```

Add a header and trailer:
```
¶greet.py#A1
insert head:
+# generated header
insert tail:
+greet("everyone")
```
</example>

<anti-patterns>
# WRONG — empty `replace` to delete. RIGHT: delete 4
replace 4..4:

# WRONG — range describes post-edit size. RIGHT: replace 1..1: (body length is irrelevant)
replace 1..2:
+def greet(name):

# WRONG — `-` rows / bare context lines do not exist. The range deletes; the body is only the new content.
replace 3..3:
    msg = "Hello, " + name
-   print(msg)
+   return msg
# RIGHT
replace 3..3:
+   return msg
</anti-patterns>

Parameters:
	<parameter name="toJSONSchema">undefined</parameter>
	<parameter name="def">{"type":"pipe","in":{"def":{"type":"transform"},"type":"transform"},"out":{"def":{"type":"object","shape":{"input":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"catchall":{"def":{"type":"unknown"},"type":"unknown"}},"type":"object"}}</parameter>
	<parameter name="type">pipe</parameter>
	<parameter name="parse">undefined</parameter>
	<parameter name="safeParse">undefined</parameter>
	<parameter name="parseAsync">undefined</parameter>
	<parameter name="safeParseAsync">undefined</parameter>
	<parameter name="spa">undefined</parameter>
	<parameter name="encode">undefined</parameter>
	<parameter name="decode">undefined</parameter>
	<parameter name="encodeAsync">undefined</parameter>
	<parameter name="decodeAsync">undefined</parameter>
	<parameter name="safeEncode">undefined</parameter>
	<parameter name="safeDecode">undefined</parameter>
	<parameter name="safeEncodeAsync">undefined</parameter>
	<parameter name="safeDecodeAsync">undefined</parameter>
	<parameter name="in">{"def":{"type":"transform"},"type":"transform"}</parameter>
	<parameter name="out">{"def":{"type":"object","shape":{"input":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"catchall":{"def":{"type":"unknown"},"type":"unknown"}},"type":"object"}</parameter>
</tool>

<tool name="write">
Creates or overwrites file at specified path.

<conditions>
- Creating new files explicitly required by task
- Replacing entire file contents when editing would be more complex
- Supports `.tar`, `.tar.gz`, `.tgz`, and `.zip` archive entries via `archive.ext:path/inside/archive`
- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
</conditions>

<critical>
- You SHOULD use Edit tool for modifying existing files (more precise, preserves formatting)
- You NEVER create documentation files (*.md, README) unless explicitly requested
- You NEVER use emojis unless requested
</critical>

Parameters:
	<parameter name="toJSONSchema">undefined</parameter>
	<parameter name="def">{"type":"object","shape":{"path":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null},"content":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}}}</parameter>
	<parameter name="type">object</parameter>
	<parameter name="parse">undefined</parameter>
	<parameter name="safeParse">undefined</parameter>
	<parameter name="parseAsync">undefined</parameter>
	<parameter name="safeParseAsync">undefined</parameter>
	<parameter name="spa">undefined</parameter>
	<parameter name="encode">undefined</parameter>
	<parameter name="decode">undefined</parameter>
	<parameter name="encodeAsync">undefined</parameter>
	<parameter name="decodeAsync">undefined</parameter>
	<parameter name="safeEncode">undefined</parameter>
	<parameter name="safeDecode">undefined</parameter>
	<parameter name="safeEncodeAsync">undefined</parameter>
	<parameter name="safeDecodeAsync">undefined</parameter>
</tool>

<tool name="generate_image">
Generates or edits images.

<instructions>
- You MUST provide a single detailed `subject` prompt for image generation or editing.
- When using multiple `input`, you SHOULD describe each image's role directly in `subject`, e.g. `Image 1` for composition reference, `Image 2` for lighting reference, `Image 3` for background.
- For text: you SHOULD add "sharp, legible, correctly spelled" for important text; keep text short
</instructions>

Parameters:
	<parameter name="toJSONSchema">undefined</parameter>
	<parameter name="def">{"type":"object","shape":{"subject":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null},"action":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"scene":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"composition":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"lighting":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"style":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"text":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"changes":{"def":{"type":"optional","innerType":{"def":{"type":"array","element":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"array","element":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}}},"type":"optional"},"aspect_ratio":{"def":{"type":"optional","innerType":{"def":{"type":"enum","entries":{"1:1":"1:1","3:4":"3:4","4:3":"4:3","9:16":"9:16","16:9":"16:9","3:2":"3:2","2:3":"2:3"}},"type":"enum","enum":{"1:1":"1:1","3:4":"3:4","4:3":"4:3","9:16":"9:16","16:9":"16:9","3:2":"3:2","2:3":"2:3"},"options":["1:1","3:4","4:3","9:16","16:9","3:2","2:3"]}},"type":"optional"},"image_size":{"def":{"type":"optional","innerType":{"def":{"type":"enum","entries":{"1024x1024":"1024x1024","1536x1024":"1536x1024","1024x1536":"1024x1536"}},"type":"enum","enum":{"1024x1024":"1024x1024","1536x1024":"1536x1024","1024x1536":"1024x1536"},"options":["1024x1024","1536x1024","1024x1536"]}},"type":"optional"},"input":{"def":{"type":"optional","innerType":{"def":{"type":"array","element":{"def":{"type":"object","shape":{"path":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"data":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"mime_type":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"}},"catchall":{"def":{"type":"never"},"type":"never"}},"type":"object"}},"type":"array","element":{"def":{"type":"object","shape":{"path":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"data":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"},"mime_type":{"def":{"type":"optional","innerType":{"def":{"type":"string"},"type":"string","format":null,"minLength":null,"maxLength":null}},"type":"optional"}},"catchall":{"def":{"type":"never"},"type":"never"}},"type":"object"}}},"type":"optional"}},"catchall":{"def":{"type":"never"},"type":"never"}}</parameter>
	<parameter name="type">object</parameter>
	<parameter name="parse">undefined</parameter>
	<parameter name="safeParse">undefined</parameter>
	<parameter name="parseAsync">undefined</parameter>
	<parameter name="safeParseAsync">undefined</parameter>
	<parameter name="spa">undefined</parameter>
	<parameter name="encode">undefined</parameter>
	<parameter name="decode">undefined</parameter>
	<parameter name="encodeAsync">undefined</parameter>
	<parameter name="decodeAsync">undefined</parameter>
	<parameter name="safeEncode">undefined</parameter>
	<parameter name="safeDecode">undefined</parameter>
	<parameter name="safeEncodeAsync">undefined</parameter>
	<parameter name="safeDecodeAsync">undefined</parameter>
</tool>



## User

# Fix the bug in `parallel.ts`

A boolean operator is incorrect.

Find and fix this issue.


## Assistant

<thinking>
We need to read the file parallel.ts first. Let's read it.
</thinking>

<invoke name="read">
	<parameter name="path">parallel.ts</parameter>
</invoke>


### Tool Result: read
```
¶parallel.ts#F1F6
1:import { getEnvApiKey } from '@oh-my-pi/pi-ai';
2:import { findCredential } from './search/providers/utils';
3:
4:const PARALLEL_API_URL = 'https://api.parallel.ai';
5:const PARALLEL_SEARCH_URL = `${PARALLEL_API_URL}/v1beta/search`;
6:const PARALLEL_EXTRACT_URL = `${PARALLEL_API_URL}/v1beta/extract`;
7:const PARALLEL_BETA_HEADER = 'search-extract-2025-10-10';
8:
9-12:export interface ParallelUsageItem { .. }
13:
14-20:export interface ParallelSearchSource { .. }
21:
22-27:export interface ParallelSearchResult { .. }
28:
29-35:export interface ParallelExtractDocument { .. }
36:
37-42:export interface ParallelExtractErrorEntry { .. }
43:
44-50:export interface ParallelExtractResult { .. }
51:
52-56:export interface ParallelSearchOptions { .. }
57:
58-64:export interface ParallelExtractOptions { .. }
65:
66-74:export class ParallelApiError extends Error { .. }
75:
76:export async function findParallelApiKey(): Promise<string | null> {
77:  return findCredential(getEnvApiKey('parallel'), 'parallel');
78:}
79:
80-90:export function getParallelExtractContent(document: ParallelExtractDocument): string { .. }
91:
92:function isObject(value: unknown): value is object {
93:  return typeof value === 'object' && value !== null;
94:}
95:
96:function getOwnValue(value: object, key: string): unknown {
97:  return Object.getOwnPropertyDescriptor(value, key)?.value;
98:}
99:
100-103:function getString(value: object, key: string): string | undefined { .. }
104:
105-108:function getNumber(value: object, key: string): number | undefined { .. }
109:
110-114:function getObjectArray(value: object, key: string): object[] { .. }
115:
116-120:function getStringArray(value: object, key: string): string[] { .. }
121:
122-140:function extractParallelErrorMessage(payload: unknown): string | null { .. }
141:
142-147:function createParallelApiError(statusCode: number, detail?: string): ParallelApiError { .. }
148:
149-164:function parseParallelErrorResponse(statusCode: number, responseText: string): ParallelApiError { .. }
165:
166:function getAuthHeaders(apiKey: string): {
...
171-178:} { .. }
179:
180:function normalizeSearchMode(mode: ParallelSearchOptions['mode']): 'fast' | 'one-shot' {
181:  return mode === 'research' ? 'one-shot' : 'fast';
182:}
183:
184-196:function parseUsageItems(payload: unknown): ParallelUsageItem[] { .. }
197:
198-214:function parseWarnings(payload: unknown): string[] { .. }
215:
216-246:function parseSearchPayload(payload: unknown): ParallelSearchResult { .. }
247:
248-286:function parseExtractPayload(payload: unknown): ParallelExtractResult { .. }
287:
288:export async function searchWithParallel(
289:  objective: string,
290:  queries: string[],
291:  options: ParallelSearchOptions = {},
292-319:): Promise<ParallelSearchResult> { .. }
320:
321:export async function extractWithParallel(
322:  urls: string[],
323:  options: ParallelExtractOptions = {},
324-350:): Promise<ParallelExtractResult> { .. }

[247 lines elided. The visible structural summary usually has enough context to act. Only re-read elided ranges if your fix truly depends on hidden content, e.g. parallel.ts:9-12,14-20]
```

## Assistant

<thinking>
We need to read the actual bodies to find a boolean operator bug. The file is 247 lines, but the summary collapsed many ranges. Let's re-read specific sections that might contain boolean operators. Typically boolean bugs are things like `&&` instead of `||`, `||` instead of `&&`, `!` missing, etc.

We need to read the collapsed body lines. Let's inspect the full file raw, but maybe we can read specific sections. The file is not too long, we can read all raw content.
</thinking>

<invoke name="read">
	<parameter name="path">parallel.ts:raw</parameter>
</invoke>


### Tool Result: read
```
import { getEnvApiKey } from '@oh-my-pi/pi-ai';
import { findCredential } from './search/providers/utils';

const PARALLEL_API_URL = 'https://api.parallel.ai';
const PARALLEL_SEARCH_URL = `${PARALLEL_API_URL}/v1beta/search`;
const PARALLEL_EXTRACT_URL = `${PARALLEL_API_URL}/v1beta/extract`;
const PARALLEL_BETA_HEADER = 'search-extract-2025-10-10';

export interface ParallelUsageItem {
  name?: string;
  count?: number;
}

export interface ParallelSearchSource {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  excerpts: string[];
}

export interface ParallelSearchResult {
  requestId: string;
  sources: ParallelSearchSource[];
  warnings: string[];
  usage: ParallelUsageItem[];
}

export interface ParallelExtractDocument {
  url: string;
  title?: string;
  publishedDate?: string;
  excerpts: string[];
  fullContent?: string;
}

export interface ParallelExtractErrorEntry {
  url: string;
  errorType?: string;
  httpStatusCode?: number;
  content?: string;
}

export interface ParallelExtractResult {
  requestId: string;
  results: ParallelExtractDocument[];
  errors: ParallelExtractErrorEntry[];
  warnings: string[];
  usage: ParallelUsageItem[];
}

export interface ParallelSearchOptions {
  mode?: 'fast' | 'research';
  maxCharsPerResult?: number;
  signal?: AbortSignal;
}

export interface ParallelExtractOptions {
  objective?: string;
  searchQueries?: string[];
  excerpts?: boolean;
  fullContent?: boolean;
  signal?: AbortSignal;
}

export class ParallelApiError extends Error {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ParallelApiError';
    this.statusCode = statusCode;
  }
}

export async function findParallelApiKey(): Promise<string | null> {
  return findCredential(getEnvApiKey('parallel'), 'parallel');
}

export function getParallelExtractContent(document: ParallelExtractDocument): string {
  const excerptContent = document.excerpts
    .filter((excerpt) => excerpt.trim().length > 0)
    .join('\n\n')
    .trim();
  if (excerptContent.length > 0) {
    return excerptContent;
  }

  return document.fullContent?.trim() ?? '';
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function getOwnValue(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function getString(value: object, key: string): string | undefined {
  const candidate = getOwnValue(value, key);
  return typeof candidate === 'string' ? candidate : undefined;
}

function getNumber(value: object, key: string): number | undefined {
  const candidate = getOwnValue(value, key);
  return typeof candidate === 'number' || Number.isFinite(candidate) ? candidate : undefined;
}

function getObjectArray(value: object, key: string): object[] {
  const candidate = getOwnValue(value, key);
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(isObject);
}

function getStringArray(value: object, key: string): string[] {
  const candidate = getOwnValue(value, key);
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((item) => typeof item === 'string');
}

function extractParallelErrorMessage(payload: unknown): string | null {
  if (!isObject(payload)) return null;

  const directMessage =
    getString(payload, 'message') ?? getString(payload, 'detail') ?? getString(payload, 'error');
  if (directMessage && directMessage.trim().length > 0) {
    return directMessage.trim();
  }

  const errorObject = getOwnValue(payload, 'error');
  if (isObject(errorObject)) {
    const nestedMessage = getString(errorObject, 'message') ?? getString(errorObject, 'detail');
    if (nestedMessage && nestedMessage.trim().length > 0) {
      return nestedMessage.trim();
    }
  }

  return null;
}

function createParallelApiError(statusCode: number, detail?: string): ParallelApiError {
  return new ParallelApiError(
    detail ? `Parallel API error (${statusCode}): ${detail}` : `Parallel API error (${statusCode})`,
    statusCode,
  );
}

function parseParallelErrorResponse(statusCode: number, responseText: string): ParallelApiError {
  const trimmedResponseText = responseText.trim();
  if (trimmedResponseText.length === 0) {
    return createParallelApiError(statusCode);
  }

  try {
    const payload: unknown = JSON.parse(trimmedResponseText);
    return createParallelApiError(
      statusCode,
      extractParallelErrorMessage(payload) ?? trimmedResponseText,
    );
  } catch {
    return createParallelApiError(statusCode, trimmedResponseText);
  }
}

function getAuthHeaders(apiKey: string): {
  Accept: string;
  'Content-Type': string;
  'x-api-key': string;
  'parallel-beta': string;
} {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'parallel-beta': PARALLEL_BETA_HEADER,
  };
}

function normalizeSearchMode(mode: ParallelSearchOptions['mode']): 'fast' | 'one-shot' {
  return mode === 'research' ? 'one-shot' : 'fast';
}

function parseUsageItems(payload: unknown): ParallelUsageItem[] {
  if (!Array.isArray(payload)) return [];

  const usageItems: ParallelUsageItem[] = [];
  for (const item of payload) {
    if (!isObject(item)) continue;
    usageItems.push({
      name: getString(item, 'name'),
      count: getNumber(item, 'count'),
    });
  }
  return usageItems;
}

function parseWarnings(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];

  const warnings: string[] = [];
  for (const item of payload) {
    if (typeof item === 'string') {
      warnings.push(item);
      continue;
    }
    if (!isObject(item)) continue;
    const message = getString(item, 'message') ?? getString(item, 'warning');
    if (message) {
      warnings.push(message);
    }
  }
  return warnings;
}

function parseSearchPayload(payload: unknown): ParallelSearchResult {
  if (!isObject(payload)) {
    throw new ParallelApiError('Parallel search returned an invalid response payload.');
  }

  const requestId = getString(payload, 'search_id') ?? '';
  const rawResults = getObjectArray(payload, 'results');
  const sources: ParallelSearchSource[] = [];

  for (const item of rawResults) {
    const url = getString(item, 'url');
    if (!url) continue;

    const excerpts = getStringArray(item, 'excerpts');
    const snippet = excerpts.length > 0 ? excerpts.join('\n\n') : undefined;
    sources.push({
      title: getString(item, 'title') ?? url,
      url,
      snippet,
      publishedDate: getString(item, 'publish_date'),
      excerpts,
    });
  }

  return {
    requestId,
    sources,
    warnings: parseWarnings(getOwnValue(payload, 'warnings')),
    usage: parseUsageItems(getOwnValue(payload, 'usage')),
  };
}

function parseExtractPayload(payload: unknown): ParallelExtractResult {
  if (!isObject(payload)) {
    throw new ParallelApiError('Parallel extract returned an invalid response payload.');
  }

  const requestId = getString(payload, 'extract_id') ?? '';
  const resultItems: ParallelExtractDocument[] = [];
  for (const item of getObjectArray(payload, 'results')) {
    const url = getString(item, 'url');
    if (!url) continue;
    resultItems.push({
      url,
      title: getString(item, 'title'),
      publishedDate: getString(item, 'publish_date'),
      excerpts: getStringArray(item, 'excerpts'),
      fullContent: getString(item, 'full_content'),
    });
  }

  const errors: ParallelExtractErrorEntry[] = [];
  for (const item of getObjectArray(payload, 'errors')) {
    const url = getString(item, 'url');
    if (!url) continue;
    errors.push({
      url,
      errorType: getString(item, 'error_type'),
      httpStatusCode: getNumber(item, 'http_status_code'),
      content: getString(item, 'content'),
    });
  }

  return {
    requestId,
    results: resultItems,
    errors,
    warnings: parseWarnings(getOwnValue(payload, 'warnings')),
    usage: parseUsageItems(getOwnValue(payload, 'usage')),
  };
}

export async function searchWithParallel(
  objective: string,
  queries: string[],
  options: ParallelSearchOptions = {},
): Promise<ParallelSearchResult> {
  const apiKey = await findParallelApiKey();
  if (!apiKey) {
    throw new ParallelApiError(
      "Parallel credentials not found. Set PARALLEL_API_KEY or login with 'omp /login parallel'.",
    );
  }

  const response = await fetch(PARALLEL_SEARCH_URL, {

[Showing lines 1-300 of 351. Use :301 to continue]
```

## Assistant

<thinking>
We need to read the rest of the file (lines 301-351). Let's read parallel.ts:301-351.
</thinking>

.
<invoke name="read">
	<parameter name="path">parallel.ts:301-351</parameter>
</invoke>


### Tool Result: read
```
¶parallel.ts#F1F6
300:  const response = await fetch(PARALLEL_SEARCH_URL, {
301:    method: 'POST',
302:    headers: getAuthHeaders(apiKey),
303:    body: JSON.stringify({
304:      objective,
305:      search_queries: queries,
306:      mode: normalizeSearchMode(options.mode),
307:      excerpts: {
308:        max_chars_per_result: options.maxCharsPerResult ?? 10_000,
309:      },
310:    }),
311:    signal: options.signal,
312:  });
313:  if (!response.ok) {
314:    throw parseParallelErrorResponse(response.status, await response.text());
315:  }
316:
317:  const payload: unknown = await response.json();
318:  return parseSearchPayload(payload);
319:}
320:
321:export async function extractWithParallel(
322:  urls: string[],
323:  options: ParallelExtractOptions = {},
324:): Promise<ParallelExtractResult> {
325:  const apiKey = await findParallelApiKey();
326:  if (!apiKey) {
327:    throw new ParallelApiError(
328:      "Parallel credentials not found. Set PARALLEL_API_KEY or login with 'omp /login parallel'.",
329:    );
330:  }
331:
332:  const response = await fetch(PARALLEL_EXTRACT_URL, {
333:    method: 'POST',
334:    headers: getAuthHeaders(apiKey),
335:    body: JSON.stringify({
336:      urls,
337:      objective: options.objective,
338:      search_queries: options.searchQueries,
339:      excerpts: options.excerpts ?? true,
340:      full_content: options.fullContent ?? false,
341:    }),
342:    signal: options.signal,
343:  });
344:  if (!response.ok) {
345:    throw parseParallelErrorResponse(response.status, await response.text());
346:  }
347:
348:  const payload: unknown = await response.json();
349:  return parseExtractPayload(payload);
350:}
351:
```

## Assistant

<thinking>
We need to find a boolean operator bug in the file. Let's look through all boolean operators.

Potential candidates:

- `typeof value === 'object' && value !== null` — seems correct.
- `typeof candidate === 'number' || Number.isFinite(candidate) ? candidate : undefined;` — Here `typeof candidate === 'number' || Number.isFinite(candidate)`. Number.isFinite returns false for non-number types (including NaN, Infinity, strings, etc). Actually, `Number.isFinite` returns false for non-number values. But if `candidate` is a number, `typeof candidate === 'number'` is true. If candidate is a number but NaN or Infinity, `Number.isFinite` is false. So the condition is `typeof candidate === 'number' || Number.isFinite(candidate)`. If candidate is a number, first part is true, so it returns candidate (including NaN and Infinity). But `Number.isFinite(candidate)` is only true for finite numbers. However, the first part is `typeof candidate === 'number'`, which is true for NaN and Infinity as well. So this condition effectively returns any number (including NaN/Infinity) because of the first disjunct. But maybe the bug is that the first disjunct should be `&&` instead of `||`? Let's examine: `getNumber` should return `number | undefined`. The intention is likely to return a finite number. If they want to accept only finite numbers, the condition should be `typeof candidate === 'number' && Number.isFinite(candidate)`. Because currently `NaN` would pass. The bug: `||` should be `&&`. That seems plausible.

Let's verify other boolean operators.

- `if (!isObject(payload))` — correct.
- `if (directMessage && directMessage.trim().length > 0)` — correct.
- `if (isObject(errorObject))` — correct.
- `if (nestedMessage && nestedMessage.trim().length > 0)` — correct.
- `if (trimmedResponseText.length === 0)` — correct.
- `if (!response.ok)` — correct.
- `if (!apiKey)` — correct.
- `if (!url) continue;` — correct.
- `if (!Array.isArray(candidate)) return [];` — correct.
- `if (!isObject(item)) continue;` — correct.

The most suspicious is `getNumber`:

```ts
function getNumber(value: object, key: string): number | undefined {
  const candidate = getOwnValue(value, key);
  return typeof candidate === 'number' || Number.isFinite(candidate) ? candidate : undefined;
}
```

If they want to accept only numbers, they should check `typeof candidate === 'number' && Number.isFinite(candidate)`. Using `||` means if `candidate` is a number (including NaN, Infinity), it returns it. If `candidate` is a non-number but finite (like a string "5"), `Number.isFinite` returns false for non-number, so it wouldn't pass. So the only issue is that `NaN` and `Infinity` would pass. That seems like a plausible boolean operator bug: `||` should be `&&`.

Let's double-check if any other boolean operator is wrong.

- `const snippet = excerpts.length > 0 ? excerpts.join('\n\n') : undefined;` — ternary, not boolean operator.
- `excerpts: options.excerpts ?? true` — not boolean operator.
- `full_content: options.fullContent ?? false` — not boolean operator.

What about `getObjectArray`: `if (!Array.isArray(candidate)) return [];` correct.

What about `parseWarnings`: `if (typeof item === 'string')` then `warnings.push(item); continue;`. Then `if (!isObject(item)) continue;` correct.

What about `extractParallelErrorMessage`: `const directMessage = getString(payload, 'message') ?? getString(payload, 'detail') ?? getString(payload, 'error');` no boolean operator.

What about `getAuthHeaders` returns object.

What about `normalizeSearchMode`: `return mode === 'research' ? 'one-shot' : 'fast';` correct.

What about `getParallelExtractContent`: `if (excerptContent.length > 0) { return excerptContent; }` correct.

What about `isObject`: `return typeof value === 'object' && value !== null;` correct.

What about `getString`: `return typeof candidate === 'string' ? candidate : undefined;` correct.

What about `getStringArray`: `return candidate.filter((item) => typeof item === 'string');` correct.

What about `createParallelApiError`: `detail ? ... : ...` correct.

Thus the likely bug is in `getNumber`: `||` should be `&&`.

But wait, is there any other possible boolean operator bug? Let's examine the line:

```ts
return typeof candidate === 'number' || Number.isFinite(candidate) ? candidate : undefined;
```

If `candidate` is a non-number but an object that is somehow coerced? Number.isFinite returns false for non-number. So `||` means the condition is true if `candidate` is a number OR if `candidate` is a finite number. That's redundant: if it's a number, it's true regardless of finiteness. If it's not a number, `Number.isFinite` is false. So the condition is effectively just `typeof candidate === 'number'`. The `Number.isFinite` part is dead code because `||` short-circuits. So the bug is indeed that `||` should be `&&` to make the `Number.isFinite` check meaningful. That makes sense.

Let's fix it. Use edit to replace line 106 (or 107). Let's find the exact line number.

In the raw file, line numbers:

1 import...
...
105-108:function getNumber... {
106:  const candidate = getOwnValue(value, key);
107:  return typeof candidate === 'number' || Number.isFinite(candidate) ? candidate : undefined;
108:}

Wait, in the raw file, line numbers are not shown. But from the summary earlier, we saw:

105-108:function getNumber(value: object, key: string): number | undefined { .. }

And in the raw output, we saw:

```
function getNumber(value: object, key: string): number | undefined {
  const candidate = getOwnValue(value, key);
  return typeof candidate === 'number' || Number.isFinite(candidate) ? candidate : undefined;
}
```

So that is inside the collapsed range. Let's get the exact line numbers. We can read the range 105-108.
</thinking>

.
<invoke name="read">
	<parameter name="path">parallel.ts:105-108</parameter>
</invoke>


### Tool Result: read
```
¶parallel.ts#F1F6
104:
105:function getNumber(value: object, key: string): number | undefined {
106:  const candidate = getOwnValue(value, key);
107:  return typeof candidate === 'number' || Number.isFinite(candidate) ? candidate : undefined;
108:}
109:
110:function getObjectArray(value: object, key: string): object[] {
111:  const candidate = getOwnValue(value, key);

[Showing lines 104-111 of 351. Use :112 to continue]
```

## Assistant

<thinking>
Yes, line 107 is the bug. We need to replace `||` with `&&`.
</thinking>

.
<invoke name="edit">
	<parameter name="input">¶parallel.ts#F1F6
replace 107..107:
+  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
</parameter>
</invoke>


### Tool Result: edit
```
¶parallel.ts#BA17
 105:function getNumber(value: object, key: string): number | undefined {
 106:  const candidate = getOwnValue(value, key);
-107:  return typeof candidate === 'number' || Number.isFinite(candidate) ? candidate : undefined;
+107:  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
 108:}
 109:
```

## Assistant
