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
  - procmgr.ts  8.6KB     just now
</workspace-tree>

Today is 2026-05-30, and the current working directory is 'C:/tmp/oh-my-pi/runs/rb-k8r1skib/duplicate-duplicate-line-flip-003-5'.

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
Let me read the file to understand the bug.
</thinking>

<invoke name="read">
	<parameter name="path">procmgr.ts</parameter>
</invoke>


### Tool Result: read
```
¶procmgr.ts#E966
1:import * as fs from 'node:fs';
2:import path from 'node:path';
3:import * as timers from 'node:timers';
4:import type { Subprocess } from 'bun';
5:import { $env } from './env';
6:
7:export interface ShellConfig {
8:  shell: string;
9:  args: string[];
10:  env: Record<string, string>;
11:  prefix: string | undefined;
12:}
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
51:function getShellArgs(): string[] {
52:  const noLogin = $env.PI_BASH_NO_LOGIN || $env.CLAUDE_BASH_NO_LOGIN;
53:  return noLogin ? ['-c'] : ['-l', '-c'];
54:}
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
238:function joinSignals(...sigs: (AbortSignal | null | undefined)[]): AbortSignal | undefined {
239:  const nn = sigs.filter(Boolean) as AbortSignal[];
240:  if (nn.length === 0) return undefined;
241:  if (nn.length === 1) return nn[0];
242:  return AbortSignal.any(nn);
243:}
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

[221 lines elided; re-read needed ranges, e.g. procmgr.ts:22-29,34-45]
```

## Assistant

<thinking>
The summary shows the overall structure. I need to find a duplicated line with a subtle literal/operator change. Let me read the full file to see the actual code.
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
Let me read the rest of the file to see all the code.
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
Let me look for duplicated lines with subtle literal/operator changes. Let me scan the file carefully.

Looking at `isPidRunning`:
```typescript
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

Wait, in `isPidRunning`, if `pid.killed` is true, it returns `true`. But if the process is killed, it shouldn't be running. That seems like a bug. Let me look at other parts.

Actually, looking at the `isPidRunning` function:
```typescript
if (pid.killed) return true;
```

If `pid.killed` is true, it returns `true`, meaning "is running". But if a process is killed, it's NOT running. So `return true` should be `return false`. But the task says "duplicated line contains a subtle literal/operator change". Let me look for duplicated patterns.

In `terminate`:
```typescript
if (typeof target === 'number') {
  process.kill(target, TERM_SIGNAL);
} else {
  target.kill(TERM_SIGNAL);
}
```

And later:
```typescript
if (typeof target === 'number') {
  process.kill(target, 'SIGKILL');
} else {
  target.kill('SIGKILL');
}
```

And in `isPidRunning`:
```typescript
if (typeof pid === 'number') {
  process.kill(pid, 0);
} else {
  if (pid.killed) return true;
  if (pid.exitCode !== null) return false;
}
```

Hmm, let me look at `isPidRunning` more carefully. The `if (pid.killed) return true;` seems wrong. A killed process is not running. But is this a "duplicated line"? Let me look at `onProcessExit`:

```typescript
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
```

Wait, in `terminate` at line 302:
```typescript
if (target.killed) return true;
```

And in `isPidRunning` at line 232:
```typescript
if (pid.killed) return true;
```

These are duplicated lines! Both check `killed` and return `true`. But in `isPidRunning`, `return true` means "the process is running". If `pid.killed` is true, the process is NOT running. So this should be `return false`.

Let me verify. In `isPidRunning`:
- `typeof pid === 'number'`: tries `process.kill(pid, 0)`, if no error, returns true
- `else` (it's a Subprocess):
  - `if (pid.killed) return true;` — if killed, say it's running? WRONG!
  - `if (pid.exitCode !== null) return false;` — if exited, say it's not running
  - `return true;` — otherwise say it's running

So `if (pid.killed) return true;` should be `if (pid.killed) return false;` because if a process is killed, it is not running.

This is a duplicated line pattern — the same check exists in `terminate` at line 302 where `if (target.killed) return true;` is correct (because `terminate` wants to say "already done, return true"). But in `isPidRunning`, `return true` means "is running", so it should be `return false`.

The task says "A duplicated line contains a subtle literal/operator change." So in `isPidRunning`, the duplicated line `if (pid.killed) return true;` should have a subtle change from `true` to `false`.
</thinking>

.
<invoke name="read">
	<parameter name="path">procmgr.ts:224-236</parameter>
</invoke>


### Tool Result: read
```
¶procmgr.ts#E966
223: */
224:export function isPidRunning(pid: number | Subprocess): boolean {
225:  try {
226:    if (typeof pid === 'number') {
227:      process.kill(pid, 0);
228:    } else {
229:      if (pid.killed) return true;
230:      if (pid.exitCode !== null) return false;
231:    }
232:    return true;
233:  } catch {
234:    return false;
235:  }
236:}
237:
238:function joinSignals(...sigs: (AbortSignal | null | undefined)[]): AbortSignal | undefined {
239:  const nn = sigs.filter(Boolean) as AbortSignal[];

[Showing lines 223-239 of 341. Use :240 to continue]
```

## Assistant

<thinking>
I found the bug. In `isPidRunning` at line 229:
```typescript
if (pid.killed) return true;
```

This is duplicated from line 302 in `terminate`:
```typescript
if (target.killed) return true;
```

But in `isPidRunning`, returning `true` means "the process is running", which is wrong if `pid.killed` is true. It should be `return false`.

The fix is to change line 229 from `return true` to `return false`.
</thinking>

.
<invoke name="edit">
	<parameter name="input">¶procmgr.ts#E966
replace 229..229:
+      if (pid.killed) return false;
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
```

## Assistant
