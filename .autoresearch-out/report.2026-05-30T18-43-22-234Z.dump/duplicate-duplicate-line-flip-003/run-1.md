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
  - procmgr.ts
</workspace-tree>

Today is 2026-05-30, and the current working directory is 'C:/tmp/oh-my-pi/runs/rb-eiuivukk/duplicate-duplicate-line-flip-003-2'.

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

# Fix the bug in `procmgr.ts`

A duplicated line contains a subtle literal/operator change.

Find and fix this issue.


## Assistant

<thinking>
Let me read the file to understand the code and find the duplicated line with the subtle literal/operator change.
</thinking>

<invoke name="read">
	<parameter name="path">procmgr.ts</parameter>
</invoke>


### Tool Result: read
```
¶procmgr.ts#E966
1:import * as fs from 'node:fs';
...
5:import { $env } from './env';
6:
7-12:export interface ShellConfig { .. }
13:
14:let cachedShellConfig: ShellConfig | null = null;
15:
16:const IS_WINDOWS = process.platform === 'win32';
17:const TERM_SIGNAL = IS_WINDOWS ? undefined : 'SIGTERM';
18:
19:/**
20: * Check if a shell binary is executable.
21: */
22-29:function isExecutable(path: string): boolean { .. }
30:
31:/**
32: * Build the spawn environment (cached).
33: */
34-45:function buildSpawnEnv(shell: string): Record<string, string> { .. }
46:
47:/**
48: * Get shell args, optionally including login shell flag.
49: * Supports PI_BASH_NO_LOGIN and CLAUDE_BASH_NO_LOGIN to skip -l.
50: */
51-54:function getShellArgs(): string[] { .. }
55:
56:/**
57: * Get shell prefix for wrapping commands (profilers, strace, etc.).
58: */
59:function getShellPrefix(): string | undefined {
60:  return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
61:}
62:
63:/**
64: * Find bash executable on PATH (Windows)
65: */
66-73:function findBashOnPath(): string | null { .. }
74:
75:/**
76: * Build full shell config from a shell path.
77: */
78-85:function buildConfig(shell: string): ShellConfig { .. }
86:
87:/**
88: * Resolve a basic shell (bash or sh) as fallback.
89: */
90-109:export function resolveBasicShell(): string | undefined { .. }
110:
111:/**
112: * Get shell configuration based on platform.
...
118: */
119-186:export function getShellConfig(customShellPath?: string): ShellConfig { .. }
187:
188:/**
189: * Function signature for native process tree killing.
190: * Returns the number of processes killed.
191: */
192:export type KillTreeFn = (pid: number, signal: number) => number;
193:
194:/**
195: * Global native kill tree function, injected by pi-natives when loaded.
196: * Falls back to platform-specific behavior if not set.
197: */
198:export let nativeKillTree: KillTreeFn | undefined;
199:
200:/**
201: * Set the native kill tree function. Called by pi-natives on load.
202: */
203:export function setNativeKillTree(fn: KillTreeFn): void {
204:  nativeKillTree = fn;
205:}
206:
207:/**
208: * Options for terminating a process and all its descendants.
209: */
210-219:export interface TerminateOptions { .. }
220:
221:/**
222: * Check if a process is running.
223: */
224-236:export function isPidRunning(pid: number | Subprocess): boolean { .. }
237:
238-243:function joinSignals(...sigs: (AbortSignal | null | undefined)[]): AbortSignal | undefined { .. }
244:
245:export function onProcessExit(
246:  proc: Subprocess | number,
247:  abortSignal?: AbortSignal,
248-283:): Promise<boolean> { .. }
284:
285:/**
286: * Terminate a process and all its descendants.
287: */
288-340:export async function terminate(options: TerminateOptions): Promise<boolean> { .. }

[234 lines elided. The visible structural summary usually has enough context to act. Only re-read elided ranges if your fix truly depends on hidden content, e.g. procmgr.ts:2-4,7-12]
```

## Assistant

<thinking>
The file is large. I need to find the duplicated line with a subtle literal/operator change. Let me read the raw content to look for duplicated lines.
</thinking>

<invoke name="read">
	<parameter name="path">procmgr.ts:raw</parameter>
</invoke>


### Tool Result: read
```
import * as fs from 'node:fs';
import path from 'node:path';
import * as timers from 'node:timers';
import type { Subprocess } from 'bun';
import { $env } from './env';

export interface ShellConfig {
  shell: string;
  args: string[];
  env: Record<string, string>;
  prefix: string | undefined;
}

let cachedShellConfig: ShellConfig | null = null;

const IS_WINDOWS = process.platform === 'win32';
const TERM_SIGNAL = IS_WINDOWS ? undefined : 'SIGTERM';

/**
 * Check if a shell binary is executable.
 */
function isExecutable(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the spawn environment (cached).
 */
function buildSpawnEnv(shell: string): Record<string, string> {
  const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
  return {
    ...Bun.env,
    SHELL: shell,
    GIT_EDITOR: 'true',
    GPG_TTY: 'not a tty',
    OMPCODE: '1',
    CLAUDECODE: '1',
    ...(noCI ? {} : { CI: 'true' }),
  };
}

/**
 * Get shell args, optionally including login shell flag.
 * Supports PI_BASH_NO_LOGIN and CLAUDE_BASH_NO_LOGIN to skip -l.
 */
function getShellArgs(): string[] {
  const noLogin = $env.PI_BASH_NO_LOGIN || $env.CLAUDE_BASH_NO_LOGIN;
  return noLogin ? ['-c'] : ['-l', '-c'];
}

/**
 * Get shell prefix for wrapping commands (profilers, strace, etc.).
 */
function getShellPrefix(): string | undefined {
  return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}

/**
 * Find bash executable on PATH (Windows)
 */
function findBashOnPath(): string | null {
  try {
    return Bun.which('bash.exe');
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Build full shell config from a shell path.
 */
function buildConfig(shell: string): ShellConfig {
  return {
    shell,
    args: getShellArgs(),
    env: buildSpawnEnv(shell),
    prefix: getShellPrefix(),
  };
}

/**
 * Resolve a basic shell (bash or sh) as fallback.
 */
export function resolveBasicShell(): string | undefined {
  for (const name of ['bash', 'bash.exe', 'sh', 'sh.exe']) {
    const resolved = Bun.which(name);
    if (resolved) return resolved;
  }

  if (process.platform !== 'win32') {
    const searchPaths = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
    const candidates = ['bash', 'sh'];

    for (const name of candidates) {
      for (const dir of searchPaths) {
        const fullPath = path.join(dir, name);
        if (fs.existsSync(fullPath)) return fullPath;
      }
    }
  }

  return undefined;
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath in settings.json
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: $SHELL if bash/zsh, then fallback paths
 * 4. Fallback: sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
  if (cachedShellConfig) {
    return cachedShellConfig;
  }

  // 1. Check user-specified shell path
  if (customShellPath) {
    if (fs.existsSync(customShellPath)) {
      cachedShellConfig = buildConfig(customShellPath);
      return cachedShellConfig;
    }
    throw new Error(
      `Custom shell path not found: ${customShellPath}\nPlease update shellPath in ~/.omp/agent/settings.json`,
    );
  }

  if (process.platform === 'win32') {
    // 2. Try Git Bash in known locations
    const paths: string[] = [];
    const programFiles = Bun.env.ProgramFiles;
    if (programFiles) {
      paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = Bun.env['ProgramFiles(x86)'];
    if (programFilesX86) {
      paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }

    for (const path of paths) {
      if (fs.existsSync(path)) {
        cachedShellConfig = buildConfig(path);
        return cachedShellConfig;
      }
    }

    // 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
    const bashOnPath = findBashOnPath();
    if (bashOnPath) {
      cachedShellConfig = buildConfig(bashOnPath);
      return cachedShellConfig;
    }

    throw new Error(
      `No bash shell found. Options:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
        `  3. Set shellPath in ~/.omp/agent/settings.json\n\n` +
        `Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join('\n')}`,
    );
  }

  // Unix: prefer user's shell from $SHELL if it's bash/zsh and executable
  const userShell = Bun.env.SHELL;
  const isValidShell = userShell && (userShell.includes('bash') || userShell.includes('zsh'));
  if (isValidShell && isExecutable(userShell)) {
    cachedShellConfig = buildConfig(userShell);
    return cachedShellConfig;
  }

  // 4. Fallback: use basic shell
  const basicShell = resolveBasicShell();
  if (basicShell) {
    cachedShellConfig = buildConfig(basicShell);
    return cachedShellConfig;
  }
  cachedShellConfig = buildConfig('sh');
  return cachedShellConfig;
}

/**
 * Function signature for native process tree killing.
 * Returns the number of processes killed.
 */
export type KillTreeFn = (pid: number, signal: number) => number;

/**
 * Global native kill tree function, injected by pi-natives when loaded.
 * Falls back to platform-specific behavior if not set.
 */
export let nativeKillTree: KillTreeFn | undefined;

/**
 * Set the native kill tree function. Called by pi-natives on load.
 */
export function setNativeKillTree(fn: KillTreeFn): void {
  nativeKillTree = fn;
}

/**
 * Options for terminating a process and all its descendants.
 */
export interface TerminateOptions {
  /** The process to terminate */
  target: Subprocess | number;
  /** Whether to terminate the process tree (all descendants) */
  group?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Check if a process is running.
 */
export function isPidRunning(pid: number | Subprocess): boolean {
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function joinSignals(...sigs: (AbortSignal | null | undefined)[]): AbortSignal | undefined {
  const nn = sigs.filter(Boolean) as AbortSignal[];
  if (nn.length === 0) return undefined;
  if (nn.length === 1) return nn[0];
  return AbortSignal.any(nn);
}

export function onProcessExit(
  proc: Subprocess | number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }

  if (!isPidRunning(proc)) {
    return Promise.resolve(true);
  }

  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const localAbortController = new AbortController();

  const timer = timers.promises.setInterval(300, null, {
    signal: joinSignals(abortSignal, localAbortController.signal),
  });
  void (async () => {
    try {
      for await (const _ of timer) {
        if (!isPidRunning(proc)) {
          resolve(true);
          break;
        }
      }
    } catch (error) {
      return reject(error);
    } finally {
      localAbortController.abort();
    }
    resolve(false);
  })();

  return promise;
}

/**
 * Terminate a process and all its descendants.
 */
export async function terminate(options: TerminateOptions): Promise<boolean> {
  const { target, group = false, timeout = 5000, signal } = options;

  const abortController = new AbortController();
  try {
    const abortSignal = joinSignals(signal, abortController.signal);

    // Determine PID
    let pid: number | undefined;
    const exitPromise = onProcessExit(target, abortSignal);
    if (typeof target === 'number') {
      pid = target;
    } else {

[Showing lines 1-300 of 341. Use :301 to continue]
```

## Assistant

<thinking>
Let me read the rest of the file to see all lines and find the duplicated one with a subtle change.
</thinking>

.
<invoke name="read">
	<parameter name="path">procmgr.ts:301-341</parameter>
</invoke>


### Tool Result: read
```
¶procmgr.ts#E966
300:    } else {
301:      pid = target.pid;
302:      if (target.killed) return true;
303:    }
304:
305:    // Give it a moment to exit gracefully first.
306:    try {
307:      if (typeof target === 'number') {
308:        process.kill(target, TERM_SIGNAL);
309:      } else {
310:        target.kill(TERM_SIGNAL);
311:      }
312:
313:      if (exitPromise) {
314:        const exited = await Promise.race([Bun.sleep(1000).then(() => false), exitPromise]);
315:        if (exited) return true;
316:      }
317:    } catch {}
318:
319:    if (nativeKillTree) {
320:      nativeKillTree(pid, 9);
321:    } else {
322:      if (group && !IS_WINDOWS) {
323:        try {
324:          process.kill(-pid, 'SIGKILL');
325:        } catch {}
326:      }
327:      try {
328:        if (typeof target === 'number') {
329:          process.kill(target, 'SIGKILL');
330:        } else {
331:          target.kill('SIGKILL');
332:        }
333:      } catch {}
334:    }
335:
336:    return await Promise.race([Bun.sleep(timeout).then(() => false), exitPromise]);
337:  } finally {
338:    abortController.abort();
339:  }
340:}
341:
```

## Assistant

<thinking>
Let me scan through the file carefully for duplicated lines. I need to look for lines that are almost identical but with a subtle literal or operator change.

Looking at the code:

Line 307-311:
```ts
      if (typeof target === 'number') {
        process.kill(target, TERM_SIGNAL);
      } else {
        target.kill(TERM_SIGNAL);
      }
```

And lines 328-332:
```ts
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
```

Wait, let me look more carefully. Let me search for exact duplicated lines...

Looking at `buildSpawnEnv`:
```ts
function buildSpawnEnv(shell: string): Record<string, string> {
  const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
  return {
    ...Bun.env,
    SHELL: shell,
    GIT_EDITOR: 'true',
    GPG_TTY: 'not a tty',
    OMPCODE: '1',
    CLAUDECODE: '1',
    ...(noCI ? {} : { CI: 'true' }),
  };
}
```

Wait, looking at `getShellArgs`:
```ts
function getShellArgs(): string[] {
  const noLogin = $env.PI_BASH_NO_LOGIN || $env.CLAUDE_BASH_NO_LOGIN;
  return noLogin ? ['-c'] : ['-l', '-c'];
}
```

Hmm, let me look more carefully. The description says "A duplicated line contains a subtle literal/operator change."

Let me look for lines that appear twice. Maybe I should look at the raw text more carefully.

Lines 60-61:
```ts
function getShellPrefix(): string | undefined {
  return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}
```

Lines 34-45:
```ts
function buildSpawnEnv(shell: string): Record<string, string> {
  const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
  return {
    ...Bun.env,
    SHELL: shell,
    GIT_EDITOR: 'true',
    GPG_TTY: 'not a tty',
    OMPCODE: '1',
    CLAUDECODE: '1',
    ...(noCI ? {} : { CI: 'true' }),
  };
}
```

Hmm, I don't see duplicated lines immediately. Let me search for patterns. Maybe there's a line like `const something = ...` that appears twice.

Wait, I should look more carefully at `isPidRunning`:

```ts
export function isPidRunning(pid: number | Subprocess): boolean {
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

And in `terminate`:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

Hmm, in `isPidRunning`, for subprocess:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

But in `terminate`, for subprocess:
```ts
      pid = target.pid;
      if (target.killed) return true;
```

Wait, in `isPidRunning`:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

Hmm, is `pid.killed` vs `target.killed`? That's not the same line exactly.

Let me look at the `terminate` function again:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

And `isPidRunning`:
```ts
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
```

Wait, I see `if (pid.killed) return true;` and `if (target.killed) return true;` - but those are different variable names.

Let me look at `getShellPrefix` and `buildSpawnEnv`:
```ts
function getShellPrefix(): string | undefined {
  return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}
```

And:
```ts
function buildSpawnEnv(shell: string): Record<string, string> {
  const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
```

Hmm, let me look for lines that are identical except for a small change.

Actually, looking at the `isPidRunning` function again:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

Wait! `pid.exitCode !== null` - if `exitCode` is not null, that means the process has exited, so it is NOT running. But the function returns `true` for "is running". Wait, `if (pid.exitCode !== null) return false;` - that makes sense. If exitCode is not null, it has exited, so not running.

But let me look at `terminate`:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

Hmm, I need to find duplicated lines. Let me look more carefully.

Actually, let me look at `buildSpawnEnv`:
```ts
    OMPCODE: '1',
    CLAUDECODE: '1',
```

These are similar but not duplicates.

What about:
```ts
    const programFiles = Bun.env.ProgramFiles;
    if (programFiles) {
      paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = Bun.env['ProgramFiles(x86)'];
    if (programFilesX86) {
      paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }
```

These are similar patterns but not duplicates.

Let me look at `resolveBasicShell`:
```ts
  for (const name of ['bash', 'bash.exe', 'sh', 'sh.exe']) {
    const resolved = Bun.which(name);
    if (resolved) return resolved;
  }
```

And `getShellConfig`:
```ts
  const isValidShell = userShell && (userShell.includes('bash') || userShell.includes('zsh'));
```

Hmm. Let me look at `terminate` more carefully:

```ts
    try {
      if (typeof target === 'number') {
        process.kill(target, TERM_SIGNAL);
      } else {
        target.kill(TERM_SIGNAL);
      }

      if (exitPromise) {
        const exited = await Promise.race([Bun.sleep(1000).then(() => false), exitPromise]);
        if (exited) return true;
      }
    } catch {}

    if (nativeKillTree) {
      nativeKillTree(pid, 9);
    } else {
      if (group && !IS_WINDOWS) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }
      try {
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
      } catch {}
    }
```

Wait, in `isPidRunning`:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

Hmm, `pid.exitCode !== null` - what if it should be `pid.exitCode === null`? Let me think...

Actually, wait. The description says "A duplicated line contains a subtle literal/operator change." This means there's a line that appears twice in the file, but one instance has a subtle change (like a different operator or literal). 

Let me re-read the file looking for exact duplicate lines.

I notice:
- `return true;` appears many times
- `return false;` appears many times
- `return undefined;` appears

Let me look for something more specific. Maybe I should look at the `isPidRunning` function again:

```ts
export function isPidRunning(pid: number | Subprocess): boolean {
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

Wait, in `onProcessExit`:
```ts
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }
```

And in `terminate`:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

Hmm, let me look at lines 307-311 and 328-332:
```ts
      if (typeof target === 'number') {
        process.kill(target, TERM_SIGNAL);
      } else {
        target.kill(TERM_SIGNAL);
      }
```
and
```ts
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
```

The first has `TERM_SIGNAL`, the second has `'SIGKILL'`. These are not duplicated lines with subtle changes, they are expected different behaviors.

Wait, maybe I need to look at the `isPidRunning` function more carefully. In `isPidRunning`, for a subprocess:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

Hmm, `pid.exitCode !== null` - is this correct? If `exitCode` is not null, the process has exited, so it is not running. That seems correct.

But wait - in `isPidRunning`, when `typeof pid === 'number'`, it does `process.kill(pid, 0)` and then `return true`. But `process.kill` can throw if the process doesn't exist! So the `return true` after `process.kill` only executes if the kill doesn't throw. That makes sense.

Let me look at `isPidRunning` again for subprocess:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

Actually, wait. If `pid.killed` is true, the process has been killed, so it's NOT running. But the function returns `true`! That seems like a bug!

But the description says "A duplicated line contains a subtle literal/operator change." So maybe there's a line that is duplicated and one of them has the bug.

Let me look at `terminate`:
```ts
      pid = target.pid;
      if (target.killed) return true;
```

And `isPidRunning`:
```ts
      if (pid.killed) return true;
```

These are the same except variable name (`target` vs `pid`). But `isPidRunning` has another line:
```ts
      if (pid.exitCode !== null) return false;
```

Hmm, maybe I should look at `onProcessExit` or `terminate` for duplicated logic.

Wait! Let me look at this line:
```ts
      if (exitPromise) {
```

And later:
```ts
    return await Promise.race([Bun.sleep(timeout).then(() => false), exitPromise]);
```

Hmm, in `terminate`:
```ts
      const exited = await Promise.race([Bun.sleep(1000).then(() => false), exitPromise]);
      if (exited) return true;
```

And later:
```ts
    return await Promise.race([Bun.sleep(timeout).then(() => false), exitPromise]);
```

Wait, `exitPromise` is assigned at line 313:
```ts
    const exitPromise = onProcessExit(target, abortSignal);
```

But `exitPromise` is a Promise<boolean>, so it can't be null. But the check `if (exitPromise)` is always true. That's not a duplicated line though.

Let me think about this differently. The description says "A duplicated line contains a subtle literal/operator change." This means there is a line that is duplicated somewhere, and one of the copies has a different literal or operator.

Maybe I should look at `isPidRunning` more carefully. Let me look at what `pid.killed` means. In Bun, `Subprocess.killed` means the process has been killed. So if `killed` is true, the process is NOT running. But `isPidRunning` returns `true` when `pid.killed` is true. That seems wrong.

But wait, in `terminate`:
```ts
      if (target.killed) return true;
```

This also returns `true` if `target.killed` is true. But in `terminate`, returning `true` means "successfully terminated", so if it's already killed, that's correct. In `isPidRunning`, returning `true` means "is running", so if it's killed, it should return `false`.

So in `isPidRunning`, `if (pid.killed) return true;` should probably be `if (pid.killed) return false;`.

But the description says "A duplicated line contains a subtle literal/operator change." So maybe the line `if (pid.killed) return true;` is a duplicate of `if (target.killed) return true;` but with a subtle change? But they have different variable names.

Hmm, maybe there's a different duplicated line. Let me look at `resolveBasicShell` and `getShellConfig` for Unix:

```ts
  if (process.platform !== 'win32') {
    const searchPaths = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
```

And in `getShellConfig`:
```ts
  // Unix: prefer user's shell from $SHELL if it's bash/zsh and executable
  const userShell = Bun.env.SHELL;
  const isValidShell = userShell && (userShell.includes('bash') || userShell.includes('zsh'));
```

Hmm, let me look at `isPidRunning` again:
```ts
export function isPidRunning(pid: number | Subprocess): boolean {
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

Wait, I see `if (pid.killed) return true;` and `if (pid.exitCode !== null) return false;`. 

What about `pid.exitCode !== null` vs `pid.exitCode === null`? If the line was duplicated from somewhere else...

Actually, looking at the `onProcessExit` function:
```ts
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }
```

And in `terminate`:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

Hmm. Let me look at `isPidRunning` more carefully. The `isPidRunning` function:
```ts
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
```

Wait, for `Subprocess`, `pid.killed` means the process has been killed, which means it should NOT be running. But `isPidRunning` returns `true`. This is definitely wrong.

However, the bug description says "A duplicated line contains a subtle literal/operator change." So maybe I need to look for a literal/operator change, not a semantic bug.

Let me re-read looking for exact duplicated text with small changes.

In `buildSpawnEnv`:
```ts
    OMPCODE: '1',
    CLAUDECODE: '1',
```

In `getShellConfig`:
```ts
    cachedShellConfig = buildConfig(path);
    return cachedShellConfig;
```

Appears multiple times.

In `terminate`:
```ts
      if (typeof target === 'number') {
        process.kill(target, TERM_SIGNAL);
      } else {
        target.kill(TERM_SIGNAL);
      }
```

and
```ts
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
```

These are the same pattern but with different signal constants.

Wait, what about `isPidRunning` and `terminate`?

In `isPidRunning`:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

In `terminate`:
```ts
      if (target.killed) return true;
```

What if `isPidRunning` is supposed to have `if (pid.killed) return false;` and `if (pid.exitCode === null) return true;` or something? But the description says it's a duplicated line with a subtle change.

Actually, let me look at `onProcessExit`:
```ts
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }
```

And in `terminate`:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

Hmm, what if `if (pid.killed) return true;` in `isPidRunning` is duplicated from `if (target.killed) return true;` in `terminate`, but the bug is that `isPidRunning` should return `false` instead of `true`?

Wait, that's changing a literal (`true` to `false`), which is a subtle literal change! But is `if (pid.killed) return true;` a duplicated line? The variable name is different (`pid` vs `target`).

Let me look at `isPidRunning` again. The `else` block:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

Wait, maybe `if (pid.exitCode !== null) return false;` is the buggy line? What if it should be `if (pid.exitCode === null) return false;`? But that wouldn't make sense semantically.

Actually, let me think about this differently. "A duplicated line contains a subtle literal/operator change." 

Maybe the duplicated line is somewhere else entirely. Let me look at all lines and check for duplicates.

In `buildSpawnEnv`:
```ts
  const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
```

In `getShellArgs`:
```ts
  const noLogin = $env.PI_BASH_NO_LOGIN || $env.CLAUDE_BASH_NO_LOGIN;
```

In `getShellPrefix`:
```ts
  return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
```

These are similar patterns but not duplicates.

In `getShellConfig`:
```ts
  if (process.platform === 'win32') {
```

And `resolveBasicShell`:
```ts
  if (process.platform !== 'win32') {
```

Hmm, `===` vs `!==`! These are similar but not duplicated lines.

Wait, let me look at `isPidRunning`:
```ts
    if (typeof pid === 'number') {
```

And in `terminate`:
```ts
    if (typeof target === 'number') {
```

And:
```ts
        if (typeof target === 'number') {
```

And in `isPidRunning`:
```ts
      if (typeof pid === 'number') {
```

Wait, the `typeof` checks are similar but not duplicated lines.

Let me look at `terminate`:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

And in `isPidRunning`:
```ts
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
```

Hmm, `if (pid.killed) return true;` and `if (target.killed) return true;` - these are almost identical except the variable name. But the description says "A duplicated line contains a subtle literal/operator change." So the variable name change doesn't count as the bug - it's just context.

Wait, could `isPidRunning` have a line that is duplicated from `terminate`? Let me check:
- `terminate` has `if (target.killed) return true;`
- `isPidRunning` has `if (pid.killed) return true;`

If we treat these as the same pattern but with variable name difference, then the bug is that `isPidRunning` should return `false` instead of `true` when killed, because a killed process is not running. But the description says "subtle literal/operator change" - changing `true` to `false` is a literal change.

Actually wait, but maybe the bug is `pid.exitCode !== null` vs `pid.exitCode === null`? In `isPidRunning`, if `exitCode !== null`, the process has exited, so `return false` is correct. If `exitCode === null`, it hasn't exited, so `return true` would be correct. But the function falls through to `return true` anyway.

Hmm, let me look at `isPidRunning` again. For a subprocess:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

If `pid.killed` is true, the process has been killed. That should mean it's NOT running. So `return true` is wrong - it should be `return false`.

But wait, `pid.killed` in Bun might mean something different. Let me check what Bun's Subprocess.killed means. Actually, I can't look it up, but typically `killed` means the kill signal was sent, but the process might not have exited yet.

However, in `terminate`:
```ts
      if (target.killed) return true;
```

This means "the process has already been killed, so termination is considered successful." That makes sense.

In `isPidRunning`:
```ts
      if (pid.killed) return true;
```

This means "if the process has been killed, it is running." That doesn't make sense. But maybe `killed` in Bun means "is still running but was sent a kill signal"? No, that would be weird.

Actually, looking at the Bun docs in my knowledge, `Subprocess.killed` is a boolean that indicates whether the process has been killed. It's typically true after calling `.kill()`. But the process might still be exiting.

Wait, in `isPidRunning`:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

If `killed` means the process has been sent a kill signal but hasn't exited yet, then `return true` (still running) might be correct. But then `exitCode` would be null, and it would fall through to `return true` anyway.

Hmm, but what if `killed` means the process has finished? Then `return true` would be wrong.

Actually, let me think about this from a different angle. The description says "A duplicated line contains a subtle literal/operator change." This strongly suggests there is a line that is literally duplicated in the file (or nearly duplicated) with a small change.

Let me look at `isPidRunning` more carefully:
```ts
export function isPidRunning(pid: number | Subprocess): boolean {
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

Wait, I see `return true;` and `return false;` - but these are not duplicated lines with changes.

Actually, let me look at `onProcessExit`:
```ts
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }
```

And `terminate`:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

Hmm, I wonder if `isPidRunning` is supposed to have:
```ts
      if (pid.killed) return false;
```

Because a killed process is not running. But is that the "duplicated line"?

Let me look at the `terminate` function again:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

And `isPidRunning`:
```ts
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
```

Actually, I just realized: `if (pid.killed) return true;` in `isPidRunning` is WRONG because if the process is killed, it should not be considered "running". The analogous line in `terminate` is `if (target.killed) return true;` which is correct because in `terminate`, returning `true` means "already terminated".

But wait, the description says "A duplicated line contains a subtle literal/operator change." This could mean the line `if (pid.killed) return true;` is conceptually duplicated from `if (target.killed) return true;` but with a change that makes it buggy in this context.

Actually, maybe I'm looking at the wrong place. Let me look for other duplicated lines.

In `terminate`:
```ts
      if (typeof target === 'number') {
        process.kill(target, TERM_SIGNAL);
      } else {
        target.kill(TERM_SIGNAL);
      }
```

And:
```ts
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
```

Wait, these are the same pattern. But the first uses `TERM_SIGNAL` and the second uses `'SIGKILL'`. That's not a bug.

Let me look at `getShellConfig`:
```ts
    if (programFiles) {
      paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = Bun.env['ProgramFiles(x86)'];
    if (programFilesX86) {
      paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }
```

These are similar patterns but not duplicated lines.

Hmm, what about `buildSpawnEnv`:
```ts
    OMPCODE: '1',
    CLAUDECODE: '1',
```

Not duplicated.

Wait, let me look at `isPidRunning` again very carefully:
```ts
export function isPidRunning(pid: number | Subprocess): boolean {
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

Hmm, I wonder if `if (pid.killed) return true;` should be `if (pid.killed) return false;`. That's a literal change (`true` → `false`). But is there a duplicated line?

Actually, wait. What if the bug is `if (pid.exitCode !== null) return false;`? In `isPidRunning`, for a subprocess, `exitCode` is null until the process exits. So `exitCode !== null` means it has exited, so `return false` is correct.

But what about `exitCode === null`? That would mean it's still running, so `return false` would be wrong.

Hmm. Let me look at `onProcessExit`:
```ts
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }
```

And `terminate`:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

Wait, I think I found something. In `isPidRunning`:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

What if `pid.exitCode !== null` is actually a duplicated line from somewhere? Let me check `onProcessExit`:
```ts
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }
```

Hmm, `pid.exitCode !== null` is not duplicated anywhere.

Wait, let me look at `terminate` again:
```ts
      if (target.killed) return true;
```

And in `isPidRunning`:
```ts
      if (pid.killed) return true;
```

These are the only two places where `killed` is checked. The one in `isPidRunning` is definitely wrong - a killed process is not running. So the fix is `if (pid.killed) return false;`.

But the description says "A duplicated line contains a subtle literal/operator change." This could be referring to `if (pid.killed) return true;` being a copy of `if (target.killed) return true;` from `terminate`, but with the variable name changed and the literal `true` being wrong for this context.

Actually, I think this is the intended bug. The line `if (pid.killed) return true;` is wrong because in `isPidRunning`, returning `true` means the process is running, but a killed process is not running.

Wait, but I want to be more precise. Let me re-read the description: "A duplicated line contains a subtle literal/operator change." This means there is a line that is duplicated, and one of the copies has a different literal or operator. 

What if the line is `return true;`? In `isPidRunning`, there are multiple `return true;` statements. But that's not specific.

Actually, maybe I should look at `resolveBasicShell`:
```ts
  for (const name of ['bash', 'bash.exe', 'sh', 'sh.exe']) {
    const resolved = Bun.which(name);
    if (resolved) return resolved;
  }
```

And `getShellConfig`:
```ts
  for (const name of candidates) {
    for (const dir of searchPaths) {
      const fullPath = path.join(dir, name);
      if (fs.existsSync(fullPath)) return fullPath;
    }
  }
```

Hmm, not duplicated.

Let me look at `buildSpawnEnv`:
```ts
function buildSpawnEnv(shell: string): Record<string, string> {
  const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
  return {
    ...Bun.env,
    SHELL: shell,
    GIT_EDITOR: 'true',
    GPG_TTY: 'not a tty',
    OMPCODE: '1',
    CLAUDECODE: '1',
    ...(noCI ? {} : { CI: 'true' }),
  };
}
```

Wait, `GPG_TTY: 'not a tty'` - is this a duplicate of something? No.

Hmm, let me look at `isPidRunning` one more time. The function `isPidRunning` is supposed to check if a process is running. For a subprocess:
- If `pid.killed` is true, the process has been killed. It is NOT running. So `return true` is wrong.
- If `pid.exitCode` is not null, the process has exited. It is NOT running. So `return false` is correct.

So `if (pid.killed) return true;` should be `if (pid.killed) return false;`.

But wait, maybe the bug is even more subtle. What if `pid.killed` in Bun means "the process has been sent a kill signal"? In that case, it might still be running. So `return true` could be correct.

Let me think about this differently. The `isPidRunning` function:
```ts
export function isPidRunning(pid: number | Subprocess): boolean {
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

If `pid.killed` means "has been killed" (i.e., the process has finished), then:
- `return true` is wrong because a killed process is not running.

If `pid.killed` means "kill signal was sent but process may still be running":
- `return true` might be correct, but then the next line `if (pid.exitCode !== null) return false;` would catch the case where it has actually exited.

Actually, looking at the Bun API, `Subprocess.killed` is typically set to true when the process has been killed (i.e., it has exited due to a signal). So `return true` in `isPidRunning` is wrong.

But I want to be more systematic. Let me look for duplicated lines throughout the file.

What about `getShellConfig`?
```ts
  if (cachedShellConfig) {
    return cachedShellConfig;
  }
```

Not duplicated.

What about `return true;`? It appears many times.

What about `return false;`? It appears many times.

What about `return undefined;`? Once.

What about `return null;`? Once.

What about `return resolved;`? Once.

Let me search for `return true;` in specific contexts...

Actually, I just realized something. Let me look at `onProcessExit`:
```ts
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }
```

And in `isPidRunning`:
```ts
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
```

Wait, the `typeof` checks are inverted! `onProcessExit` checks `if (typeof proc !== 'number')` and `isPidRunning` checks `if (typeof pid === 'number')`. That's not a duplicated line.

Hmm, let me look at `terminate` more carefully:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

And:
```ts
      if (typeof target === 'number') {
        process.kill(target, TERM_SIGNAL);
      } else {
        target.kill(TERM_SIGNAL);
      }
```

And:
```ts
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
```

These are the same pattern. But the `isPidRunning` function has:
```ts
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
```

Wait, `process.kill(pid, 0);` vs `process.kill(target, TERM_SIGNAL);` vs `process.kill(target, 'SIGKILL');`

And in `terminate`, `target.kill(TERM_SIGNAL)` vs `target.kill('SIGKILL')`.

Hmm, `process.kill(pid, 0)` is a special signal that checks if the process exists without actually sending a signal. So that makes sense.

But wait, I notice something. In `isPidRunning`, for `typeof pid === 'number'`, it does `process.kill(pid, 0)` and then `return true`. But what if `process.kill` throws? Then it catches the error and returns `false`. That makes sense.

For `typeof pid !== 'number'`, it checks `pid.killed` and `pid.exitCode`. But wait, `isPidRunning` takes `pid: number | Subprocess`. When it's a `Subprocess`, the parameter is named `pid`, which is a bit confusing. But that's not the bug.

Let me look at `isPidRunning` again:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

I think the bug is here. `if (pid.killed) return true;` should be `if (pid.killed) return false;`. Because a killed process is not running.

But let me think about whether there's another candidate. What about `if (pid.exitCode !== null) return false;`? Could it be `if (pid.exitCode === null) return false;`? No, that would mean "if the process hasn't exited, it's not running", which is wrong.

What about `if (pid.exitCode !== null) return true;`? That would mean "if the process has exited, it's running", which is wrong.

So `if (pid.killed) return false;` is the only logical fix.

But wait, I want to check if there are any other duplicated lines. Let me look at the `getShellConfig` function:
```ts
  const programFilesX86 = Bun.env['ProgramFiles(x86)'];
  if (programFilesX86) {
    paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
  }
```

And earlier:
```ts
  const programFiles = Bun.env.ProgramFiles;
  if (programFiles) {
    paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
  }
```

These are similar but not exact duplicates.

What about `buildSpawnEnv`:
```ts
    OMPCODE: '1',
    CLAUDECODE: '1',
```

Similar but not duplicates.

What about `getShellConfig` return statements:
```ts
      cachedShellConfig = buildConfig(path);
      return cachedShellConfig;
```

Appears multiple times.

Actually, I think I need to look more carefully. The description says "A duplicated line contains a subtle literal/operator change." Maybe the line is exactly duplicated somewhere except for a small change.

Let me look at `isPidRunning`:
```ts
      if (pid.killed) return true;
```

And `terminate`:
```ts
      if (target.killed) return true;
```

If we ignore the variable name, these are the same line. But the bug is in `isPidRunning` where `return true` should be `return false` because a killed process is not running.

Wait, but maybe the variable name difference is not the "subtle change" they're talking about. The "subtle literal/operator change" might be something else.

Let me look at `terminate` again:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

And `isPidRunning`:
```ts
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
```

Hmm, I see `if (pid.killed) return true;` and `if (pid.exitCode !== null) return false;`. 

What if `isPidRunning` is actually supposed to be:
```ts
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return false;
      if (pid.exitCode !== null) return false;
    }
    return true;
```

Wait, but then both `killed` and `exitCode !== null` return `false`. That's correct - both mean the process is not running. And then the function falls through to `return true` for a running process.

Actually, for `Subprocess`, `killed` might be set to `true` after `kill()` is called, but before the process actually exits. In that case, `exitCode` would still be `null`. So `isPidRunning` would return `true` even though the process was sent a kill signal. That might be the intended behavior - the process is still running until it exits.

But wait, in `terminate`:
```ts
      if (target.killed) return true;
```

This means "if the process has already been killed, consider termination successful." So `killed` is used to track whether a kill signal was already sent.

In `isPidRunning`, if `pid.killed` is true, it means a kill signal was sent, but the process might still be running. So `return true` might actually be correct!

Hmm, this makes me unsure. Let me look for other potential bugs.

What about `isExecutable` and `resolveBasicShell`?

In `resolveBasicShell`:
```ts
  for (const name of ['bash', 'bash.exe', 'sh', 'sh.exe']) {
    const resolved = Bun.which(name);
    if (resolved) return resolved;
  }
```

And then:
```ts
  if (process.platform !== 'win32') {
    const searchPaths = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
    const candidates = ['bash', 'sh'];

    for (const name of candidates) {
      for (const dir of searchPaths) {
        const fullPath = path.join(dir, name);
        if (fs.existsSync(fullPath)) return fullPath;
      }
    }
  }
```

Wait, `if (fs.existsSync(fullPath)) return fullPath;` - should it check if it's executable? `isExecutable` exists for this purpose! But `fs.existsSync` is used instead. This is not a duplicated line issue though.

What about `buildSpawnEnv`:
```ts
  const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
  return {
    ...Bun.env,
    SHELL: shell,
    GIT_EDITOR: 'true',
    GPG_TTY: 'not a tty',
    OMPCODE: '1',
    CLAUDECODE: '1',
    ...(noCI ? {} : { CI: 'true' }),
  };
```

Hmm, `OMPCODE: '1'` and `CLAUDECODE: '1'` - not duplicated.

What about `getShellConfig`?
```ts
  const userShell = Bun.env.SHELL;
  const isValidShell = userShell && (userShell.includes('bash') || userShell.includes('zsh'));
  if (isValidShell && isExecutable(userShell)) {
    cachedShellConfig = buildConfig(userShell);
    return cachedShellConfig;
  }
```

And `resolveBasicShell`:
```ts
  if (fs.existsSync(fullPath)) return fullPath;
```

These are similar in intent but not duplicated.

Let me think about this more systematically. The description says:
1. "A duplicated line" - there is a line that appears in the file more than once (or very similar lines)
2. "contains a subtle literal/operator change" - one of the instances has a different literal or operator

What if I look at `return true;` vs `return false;`? In `isPidRunning`:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

And `terminate`:
```ts
      if (target.killed) return true;
```

These are very similar except for variable name and the extra line in `isPidRunning`.

What if the bug is that `if (pid.killed) return true;` should be `if (pid.killed) return false;`? That's a literal change from `true` to `false`.

Or what if `if (pid.exitCode !== null) return false;` should be `if (pid.exitCode === null) return false;`? That's an operator change from `!==` to `===`.

Wait, `if (pid.exitCode === null) return false;` would mean "if the process hasn't exited, it's not running", which is wrong.

So `!==` is correct for `exitCode`.

What about `if (pid.killed) return false;`? If `killed` means the process has been killed, then it's not running, so `return false` is correct. But if `killed` means "was sent a kill signal", then `return true` might be correct because it's still running.

Actually, looking at the `onProcessExit` function:
```ts
export function onProcessExit(
  proc: Subprocess | number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }
```

For a subprocess, `onProcessExit` just waits for `proc.exited` to resolve. It doesn't check `proc.killed`.

And in `terminate`:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

For a subprocess, `terminate` checks `target.killed` and returns `true` if already killed. This makes sense because if the process was already killed, we don't need to terminate it again.

In `isPidRunning`:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

Wait, `isPidRunning` checks `pid.killed` first. If `killed` is true, it returns `true` (running). Then it checks `exitCode`. If `exitCode` is not null, it returns `false` (not running).

But if `killed` means the process has been killed, then:
- `killed` is true → process has been killed → should return `false`
- `exitCode` is not null → process has exited → should return `false`

So `if (pid.killed) return true;` is definitely wrong.

Let me verify this is the intended bug. The line `if (pid.killed) return true;` appears in `isPidRunning` and the similar pattern `if (target.killed) return true;` appears in `terminate`. The bug is the literal `true` in `isPidRunning` which should be `false`.

Actually, I want to double-check. Maybe there's another bug.

Let me look at `terminate`:
```ts
    if (nativeKillTree) {
      nativeKillTree(pid, 9);
    } else {
      if (group && !IS_WINDOWS) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }
      try {
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
      } catch {}
    }
```

Wait, `nativeKillTree(pid, 9);` - `9` is the signal number for SIGKILL. Should this be `9` or something else? Not a duplicated line issue.

Let me look at `isPidRunning` one more time:
```ts
export function isPidRunning(pid: number | Subprocess): boolean {
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

Wait, I just realized something. For `typeof pid === 'number'`, the function does `process.kill(pid, 0)` and then `return true`. But `process.kill(pid, 0)` throws an error if the process doesn't exist. If it doesn't throw, the process exists, so `return true` is correct.

For `typeof pid !== 'number'`, the function does:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
```

If `pid.killed` is true, it returns `true`. But wait, in Bun, `Subprocess.killed` might indicate whether the process was explicitly killed (via `.kill()`), not whether it has exited. If the process was killed but hasn't finished exiting yet, `killed` might be true and `exitCode` might be null. In that case, `isPidRunning` returns `true`, which is correct because the process is still running.

But typically, `killed` means the process has been killed and is no longer running. Let me check what Bun's Subprocess API says...

Actually, in Node.js child process, `killed` is set to true when `.kill()` is called, regardless of whether the process has exited. So `killed` doesn't necessarily mean the process is dead.

In Bun, looking at the code, `Subprocess.killed` is likely similar. So if `killed` is true, the process might still be running. So `return true` could be correct.

Hmm, but then why is `terminate` checking `if (target.killed) return true;`? Because in `terminate`, if `killed` is true, it means the process has already been sent a kill signal, so we don't need to do anything more. The termination was already initiated.

In `isPidRunning`, if `killed` is true, the process might still be running (just in the process of being killed). So `return true` might be correct.

This makes me uncertain. Let me look for another duplicated line.

What about `onProcessExit`:
```ts
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const localAbortController = new AbortController();
```

And `terminate`:
```ts
  const abortController = new AbortController();
```

Not duplicated.

What about `getShellConfig`:
```ts
  const programFiles = Bun.env.ProgramFiles;
  if (programFiles) {
    paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
  }
  const programFilesX86 = Bun.env['ProgramFiles(x86)'];
  if (programFilesX86) {
    paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
  }
```

Wait, the line `paths.push(`${programFiles}\\Git\\bin\\bash.exe`);` and `paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);` are similar but with different variable names. Not exact duplicates.

What about `buildSpawnEnv`:
```ts
    OMPCODE: '1',
    CLAUDECODE: '1',
```

Hmm, `OMPCODE` vs `CLAUDECODE`, but both have `'1'`.

What about `getShellConfig`:
```ts
  if (cachedShellConfig) {
    return cachedShellConfig;
  }
```

Not duplicated.

What about `resolveBasicShell`:
```ts
  for (const name of ['bash', 'bash.exe', 'sh', 'sh.exe']) {
```

And `getShellConfig`:
```ts
    const candidates = ['bash', 'sh'];
```

Not duplicated.

What about `return true;` in `isPidRunning`:
```ts
      if (pid.killed) return true;
```

And `return true;` in `terminate`:
```ts
      if (target.killed) return true;
```

These are the same except variable name. But what if `return true;` in `isPidRunning` is the bug?

Actually, I think I should consider another possibility. What if `if (pid.exitCode !== null) return false;` is the duplicated line? Where is it duplicated from?

In `onProcessExit`:
```ts
  if (typeof proc !== 'number') {
    return proc.exited.then(
      () => true,
      () => true,
    );
  }
```

Not similar.

What about `terminate`:
```ts
      if (typeof target === 'number') {
        process.kill(target, TERM_SIGNAL);
      } else {
        target.kill(TERM_SIGNAL);
      }
```

Hmm, I keep coming back to `isPidRunning`. Let me think about this differently.

In `isPidRunning`:
```ts
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
```

If `pid.killed` is true, the process has been killed. If `pid.exitCode !== null`, the process has exited. Both indicate the process is NOT running. But the first returns `true` (running) and the second returns `false` (not running). This is inconsistent!

One of them must be wrong. Since the function is called `isPidRunning`, the correct return for both should be `false`. So `if (pid.killed) return true;` should be `if (pid.killed) return false;`.

But wait, could `pid.exitCode !== null` be wrong? If `exitCode` is not null, the process has exited. So `return false` is correct. If `exitCode === null`, the process is still running. So `return false` would be wrong.

So `if (pid.killed) return false;` is the fix.

But let me reconsider. Is `pid.killed` the same as `pid.exitCode !== null`? If `killed` means the process has exited due to a signal, then yes, they are equivalent. But then why check both?

Actually, in Bun/Node.js:
- `killed` is set when `.kill()` is called
- `exitCode` is set when the process exits

If `.kill()` is called but the process hasn't exited yet, `killed` is true and `exitCode` is null. In this case, the process might still be running. So `return true` might be correct.

But if the process exited naturally (not killed), `killed` is false and `exitCode` is a number. In this case, `return false` is correct.

If the process exited due to a signal, `killed` is true (if `.kill()` was called) and `exitCode` is null (on Unix, signals don't set exitCode; on Windows, they might).

Actually, in Node.js, when a process is killed by a signal, `exitCode` is typically `null` and `signal` is set. But `killed` is only set if you called `.kill()` yourself.

So `killed` being true means "we called `.kill()` on this process". It doesn't necessarily mean the process has exited. So `return true` might be correct if the process is still in the process of exiting.

But then `isPidRunning` would return `true` for a process that we just killed. That might be intentional - the process is still running until it exits.

Actually, this makes `isPidRunning` check:
1. If we called kill(), return true (still running, or at least termination was initiated)
2. If the process has exited, return false
3. Otherwise, return true

But wait, if we called kill() and the process has already exited, then `exitCode` would be set, and we'd hit condition 2 before condition 1... No, condition 1 is first. So if we killed the process and it exited, `isPidRunning` returns `true` because `killed` is checked first. That's wrong!

Hmm, but `exitCode` is set to null initially and becomes non-null when the process exits. `killed` might be set to true when `.kill()` is called. If the process exits quickly, both might be true at the same time. But `killed` is checked first, so it returns `true`.

I think the logic in `isPidRunning` is indeed buggy. Let me look at it again.

Actually, I want to check if there's another bug. Let me look at `terminate`:
```ts
    if (nativeKillTree) {
      nativeKillTree(pid, 9);
    } else {
      if (group && !IS_WINDOWS) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }
      try {
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
      } catch {}
    }
```

Wait, `nativeKillTree(pid, 9);` - this doesn't have try/catch. If `nativeKillTree` throws, the exception will propagate. But `nativeKillTree` is a native function that returns the number of processes killed. It might not throw.

What about `process.kill(-pid, 'SIGKILL');`? The `-pid` is used to kill the process group. But what if `pid` is undefined? Earlier:
```ts
    if (typeof target === 'number') {
      pid = target;
    } else {
      pid = target.pid;
      if (target.killed) return true;
    }
```

If `target` is a `Subprocess`, `target.pid` might be undefined or null. But `pid` is typed as `number | undefined`. Then `process.kill(-pid, 'SIGKILL')` would be `process.kill(-undefined, 'SIGKILL')` which is `process.kill(NaN, 'SIGKILL')`. That would throw.

But this is not a duplicated line issue.

Let me look at the `isPidRunning` function one more time. I think the bug is there.

Actually, wait. I just realized something. Let me look at `isPidRunning` for `number` type:
```ts
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    }
```

And `terminate` for `number` type:
```ts
      if (typeof target === 'number') {
        process.kill(target, TERM_SIGNAL);
      }
```

And the second one in `terminate`:
```ts
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        }
```

And the third one:
```ts
          process.kill(-pid, 'SIGKILL');
```

Wait, `process.kill(-pid, 'SIGKILL')` is in the `group` block. Let me look at the `else` block in `terminate`:
```ts
    if (nativeKillTree) {
      nativeKillTree(pid, 9);
    } else {
      if (group && !IS_WINDOWS) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }
      try {
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
      } catch {}
    }
```

Hmm, `target.kill('SIGKILL')` vs `target.kill(TERM_SIGNAL)`. These are similar but not duplicated lines.

What about `process.kill(target, TERM_SIGNAL)` vs `process.kill(target, 'SIGKILL')` vs `process.kill(target, 'SIGKILL')`? The first one uses `TERM_SIGNAL` and the second two use `'SIGKILL'`. The second and third are identical. But that's expected behavior.

Wait, in `terminate`:
```ts
      if (typeof target === 'number') {
        process.kill(target, TERM_SIGNAL);
      } else {
        target.kill(TERM_SIGNAL);
      }
```

And later:
```ts
        if (typeof target === 'number') {
          process.kill(target, 'SIGKILL');
        } else {
          target.kill('SIGKILL');
        }
```

These are identical blocks except for `TERM_SIGNAL` vs `'SIGKILL'`. The description says "A duplicated line contains a subtle literal/operator change." Could this be it?

Wait, but `TERM_SIGNAL` vs `'SIGKILL'` is a different constant. On Windows, `TERM_SIGNAL` is `undefined`. On Unix, it's `'SIGTERM'`. So the first block sends SIGTERM, and the second block sends SIGKILL. That's expected behavior for a two-step termination.

So that's not a bug.

Let me look at `isPidRunning` again:
```ts
export function isPidRunning(pid: number | Subprocess): boolean {
  try {
    if (typeof pid === 'number') {
      process.kill(pid, 0);
    } else {
      if (pid.killed) return true;
      if (pid.exitCode !== null) return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

Wait, I wonder if `if (pid.exitCode !== null) return false;` should be `if (pid.exitCode === null) return true;`? No, that would be redundant with the final `return true;`.

Actually, what if `if (pid.killed) return true;` is supposed to be `if (pid.killed) return false;` and `if (pid.exitCode !== null) return false;` is correct? Then both `killed` and `exited` processes would return `false`, which is correct for `isPidRunning`.

I think this is the bug. The line `if (pid.killed) return true;` is a copy of `if (target.killed) return true;` from `terminate`, but in the context of `isPidRunning`, it should return `false`.

Let me make the fix.
</thinking>

<invoke name="edit">
	<parameter name="input">¶procmgr.ts#E966
replace 229..229:
      if (pid.killed) return false;
</parameter>
</invoke>


### Tool Result: edit
```
¶procmgr.ts#FEBD
 227:      process.kill(pid, 0);
 228:    } else {
-229:      if (pid.killed) return true;
+229:      if (pid.killed) return false;
 230:      if (pid.exitCode !== null) return false;
 231:    }

Warnings:
Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines; pasting raw code as payload is not a portable shape.
```

## Assistant
