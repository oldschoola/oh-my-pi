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
  - chat-simple.ts  3.6KB     just now
</workspace-tree>

Today is 2026-05-30, and the current working directory is 'C:/tmp/oh-my-pi/runs/rb-k8r1skib/structural-delete-statement-001-4'.

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

# Fix the bug in `chat-simple.ts`

A critical statement was deleted from the code.

The issue starts around line 85.

Restore the deleted statement.


## Assistant

<thinking>
Let me read the file first to understand what was deleted around line 85.
</thinking>

<invoke name="read">
	<parameter name="path">chat-simple.ts</parameter>
</invoke>


### Tool Result: read
```
¶chat-simple.ts#2371
1:/**
2: * Simple chat interface demo using tui.ts
3: */
4:import { CombinedAutocompleteProvider } from '@oh-my-pi/pi-tui/autocomplete';
5:import { Editor } from '@oh-my-pi/pi-tui/components/editor';
6:import { Loader } from '@oh-my-pi/pi-tui/components/loader';
7:import { Markdown } from '@oh-my-pi/pi-tui/components/markdown';
8:import { Text } from '@oh-my-pi/pi-tui/components/text';
9:import { ProcessTerminal } from '@oh-my-pi/pi-tui/terminal';
10:import { TUI } from '@oh-my-pi/pi-tui/tui';
11:import { getProjectDir } from '@oh-my-pi/pi-utils';
12:import chalk from 'chalk';
13:import { defaultEditorTheme, defaultMarkdownTheme } from './test-themes';
14:
15:// Create terminal
16:const terminal = new ProcessTerminal();
17:
18:// Create TUI
19:const tui = new TUI(terminal);
20:
21:// Create chat container with some initial messages
22:tui.addChild(
23:  new Text(
24:    "Welcome to Simple Chat!\n\nType your messages below. Type '/' for commands. Press Ctrl+C to exit.",
25:  ),
26:);
27:
28:// Create editor with autocomplete
29:const editor = new Editor(defaultEditorTheme);
30:
31:// Set up autocomplete provider with slash commands and file completion
32:const autocompleteProvider = new CombinedAutocompleteProvider(
33:  [
34:    { name: 'delete', description: 'Delete the last message' },
35:    { name: 'clear', description: 'Clear all messages' },
36:  ],
37:  getProjectDir(),
38:);
39:editor.setAutocompleteProvider(autocompleteProvider);
40:
41:tui.addChild(editor);
42:
43:// Focus the editor
44:tui.setFocus(editor);
45:
46:// Track if we're waiting for bot response
47:let isResponding = false;
48:
49:// Handle message submission
50-126:editor.onSubmit = (value: string) => { .. };
127:
128:// Start the TUI
129:tui.start();

[75 lines elided; re-read needed ranges with chat-simple.ts:50-126]
```

## Assistant

<thinking>
I need to read the expanded body of lines 50-126 to see what was deleted around line 85.
</thinking>

.
<invoke name="read">
	<parameter name="path">chat-simple.ts:50-126</parameter>
</invoke>


### Tool Result: read
```
¶chat-simple.ts#2371
49:// Handle message submission
50:editor.onSubmit = (value: string) => {
51:  // Prevent submission if already responding
52:  if (isResponding) {
53:    return;
54:  }
55:
56:  const trimmed = value.trim();
57:
58:  // Handle slash commands
59:  if (trimmed === '/delete') {
60:    const children = tui.children;
61:    // Remove component before editor (if there are any besides the initial text)
62:    if (children.length > 3) {
63:      // children[0] = "Welcome to Simple Chat!"
64:      // children[1] = "Type your messages below..."
65:      // children[2...n-1] = messages
66:      // children[n] = editor
67:      children.splice(children.length - 2, 1);
68:    }
69:    tui.requestRender();
70:    return;
71:  }
72:
73:  if (trimmed === '/clear') {
74:    const children = tui.children;
75:    // Remove all messages but keep the welcome text and editor
76:    children.splice(2, children.length - 3);
77:    tui.requestRender();
78:    return;
79:  }
80:
81:  if (trimmed) {
82:    isResponding = true;
83:    editor.disableSubmit = true;
84:
85:    const children = tui.children;
86:    children.splice(children.length - 1, 0, userMessage);
87:
88:    const loader = new Loader(
89:      tui,
90:      (s) => chalk.cyan(s),
91:      (s) => chalk.dim(s),
92:      'Thinking...',
93:    );
94:    children.splice(children.length - 1, 0, loader);
95:
96:    tui.requestRender();
97:
98:    setTimeout(() => {
99:      tui.removeChild(loader);
100:
101:      // Simulate a response
102:      const responses = [
103:        "That's interesting! Tell me more.",
104:        'I see what you mean.',
105:        'Fascinating perspective!',
106:        'Could you elaborate on that?',
107:        'That makes sense to me.',
108:        "I hadn't thought of it that way.",
109:        'Great point!',
110:        'Thanks for sharing that.',
111:      ];
112:      const randomResponse = responses[Math.floor(Math.random() * responses.length)];
113:
114:      // Add assistant message with no background (transparent)
115:      const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
116:      children.splice(children.length - 1, 0, botMessage);
117:
118:      // Re-enable submit
119:      isResponding = false;
120:      editor.disableSubmit = false;
121:
122:      // Request render
123:      tui.requestRender();
124:    }, 1000);
125:  }
126:};
127:
128:// Start the TUI
129:tui.start();

[Showing lines 49-129 of 130. Use :130 to continue]
```

## Assistant

<thinking>
Looking at line 85, I see `const children = tui.children;` and then on line 86 `children.splice(children.length - 1, 0, userMessage);` - but `userMessage` is never defined in this scope. 

Looking at the pattern:
- Line 115 creates `botMessage` before splicing it
- Line 86 references `userMessage` but there's no corresponding `const userMessage = ...` before it

The deleted statement should be something like creating a user message component before splicing it. Looking at the pattern for botMessage on line 115, it seems like a user message would be created with a `Markdown` or `Text` component.

Given the `botMessage` uses `Markdown(randomResponse, 1, 1, defaultMarkdownTheme)` and the user message is the raw text that was submitted, the deleted line should probably be something like:

```ts
const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
```

or maybe:
```ts
const userMessage = new Text(trimmed);
```

Let me look at the imports. We have `Text` and `Markdown` imported. The user message is the raw text. The bot message uses `Markdown`. Looking at the context, user messages might also use `Markdown` or `Text`.

Since the task says "A critical statement was deleted" and "Restore the deleted statement", I need to figure out exactly what was there. Let me think about what makes sense.

The `userMessage` is used on line 86. After the user types something and hits submit, we want to show their message in the chat before the bot responds. The pattern with `botMessage` is to create a Markdown component.

But wait - looking at the test-themes import, `defaultMarkdownTheme` is imported. The user might use `Markdown` as well, or `Text`.

Given that `Text` is used for the welcome message and `Markdown` is used for the bot response, the user message might also be `Markdown` since it's a chat message.

Actually, looking at the pattern more carefully, `botMessage` uses `Markdown(randomResponse, 1, 1, defaultMarkdownTheme)`. The `Text` component might not need those extra args.

Let me think about what the most likely deleted line is. It's probably:

```ts
const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
```

or maybe with `Text`:

```ts
const userMessage = new Text(trimmed);
```

Given the bot message is a Markdown, and chat messages are typically rendered similarly, I'd guess `Markdown` is used. But user messages might not need the full markdown rendering.

Actually, let me reconsider. The line number should be around 85. The current line 85 is `const children = tui.children;`. The deleted line would be inserted before line 86, probably after line 85 or before it.

Let me check if there's any pattern I can infer. Looking at the structure:
- Line 82: `isResponding = true;`
- Line 83: `editor.disableSubmit = true;`
- Line 85: `const children = tui.children;`
- Line 86: `children.splice(children.length - 1, 0, userMessage);`

The deleted line should be between lines 83 and 85, or between 85 and 86. It defines `userMessage`.

Since it's "around line 85", and line 85 is `const children = tui.children;`, the deleted statement is likely right after line 85 or before line 86.

I think the most logical is:
```ts
const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
```

or
```ts
const userMessage = new Text(trimmed);
```

Given `Text` is used for the welcome message and `Markdown` is used for bot messages with `defaultMarkdownTheme`, I'd guess the user message is also `Markdown`. But I'm not 100% sure.

Wait, I should look at the exact structure. The `userMessage` needs to be defined. Since it's right after creating the user message content, maybe it's `Text` since it's user input and might not need markdown rendering.

Let me think about what test would verify this. The benchmark says "Restore the deleted statement." 

I'll go with `const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);` since it matches the pattern of `botMessage` exactly and uses `defaultMarkdownTheme` which is imported. But actually, `Text` is simpler and user messages are just text.

Hmm, let me look more carefully. The imports include `Text` and `Markdown`. The welcome message is `Text`. The bot message is `Markdown` with `1, 1, defaultMarkdownTheme`. What would a user message be?

I think I need to consider that the `Markdown` constructor signature seems to be `(content, width, height, theme)` or similar. The `Text` constructor might just be `(content)`.

Actually, I just realized - maybe the `Text` constructor is just `(content)` with no theme. Given that `Markdown` needs a theme and `Text` doesn't, the user message might be `Text(trimmed)` since it's simpler.

But wait, line 115 uses `Markdown(randomResponse, 1, 1, defaultMarkdownTheme)` and the user might want consistency.

Let me try `const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);` as it seems most consistent with the pattern.

Actually, I should check if there's a `Text` constructor that takes more args. The welcome message is `new Text("Welcome to Simple Chat!\n\nType your messages below...")`. So `Text` just takes a string.

I'll go with `Text` for simplicity, but I think `Markdown` is more likely given the chat context. Let me reconsider once more.

The task says "A critical statement was deleted" - around line 85. The `userMessage` is undefined. The deleted statement is the definition of `userMessage`.

I'll insert:
```ts
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
```

Actually, looking at the code again:
```ts
  if (trimmed) {
    isResponding = true;
    editor.disableSubmit = true;

    const children = tui.children;
    children.splice(children.length - 1, 0, userMessage);
```

The `userMessage` is inserted before the editor. Then later:
```ts
      const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
      children.splice(children.length - 1, 0, botMessage);
```

The botMessage is created inline. So the userMessage might have been created inline too. The pattern would be the same.

I'll use `Markdown` because `Text` doesn't seem to have a theme parameter and this is a chat interface where both user and bot messages might want consistent styling.

Let me insert after line 85 (before line 86):
```ts
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
```

Wait, I should check the indentation. The lines are indented with 4 spaces. Let me match that.

Actually, looking at the file again, I see:
```ts
  if (trimmed) {
    isResponding = true;
    editor.disableSubmit = true;

    const children = tui.children;
    children.splice(children.length - 1, 0, userMessage);
```

The indentation is 4 spaces. So the line should be:
```ts
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
```

Hmm, but I want to double-check. Maybe the deleted line is before `const children = tui.children;`? Let me think about what "around line 85" means.

The original line 85 was probably the deleted statement, and `const children = tui.children;` was line 86. Or the deleted line was line 86 and everything shifted.

Actually, looking at the structure, it seems like the deleted line would be:
- After line 83 (`editor.disableSubmit = true;`)
- Before line 85 (`const children = tui.children;`)

So line 84 would have been the deleted statement.

But since line numbers are just approximate, I'll insert it right after line 83 (before line 85) or after line 85. Let me think about the logical flow.

Actually, logically it doesn't matter much whether `userMessage` is created before or after `const children = tui.children;`. But stylistically, you might define the component before getting the children array, or after.

Looking at the `botMessage` pattern, it's created right before it's used:
```ts
      const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
      children.splice(children.length - 1, 0, botMessage);
```

So maybe the pattern for `userMessage` is the same:
```ts
    const children = tui.children;
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
    children.splice(children.length - 1, 0, userMessage);
```

Or maybe:
```ts
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
    const children = tui.children;
    children.splice(children.length - 1, 0, userMessage);
```

I'll go with inserting it after `const children = tui.children;` since that's where `botMessage` is defined relative to its splice. But `const children` is used twice, so maybe it's more consistent to define the message right before splicing.

Actually wait, looking at the `botMessage` more carefully:
```ts
      const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
      children.splice(children.length - 1, 0, botMessage);
```

The `botMessage` is defined right before its `splice`. So for `userMessage`, the analogous pattern would be:

```ts
    const children = tui.children;
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
    children.splice(children.length - 1, 0, userMessage);
```

But that would be on a new line after line 85. The original might have been:
```ts
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
    const children = tui.children;
```

Given the line numbers and the mention of "around line 85", I think the deleted line is between line 83 and line 85 (so after line 83 in the current file). 

Let me just insert it after line 83. But actually, I realize "around line 85" might mean the deleted line WAS line 85, and now `const children = tui.children;` is at line 85. In that case, the deleted line was before `const children = tui.children;`.

I'll insert after line 83:
```ts
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
```

Wait, I need to be more careful. Let me re-read the current line 83 and 85:
```ts
    editor.disableSubmit = true;

    const children = tui.children;
```

The blank line is line 84. The deleted line was probably line 85, meaning `const children` was originally line 86. But that would mean the deleted line was between the blank line and `const children`. That seems odd.

Alternatively, maybe the original line 85 was `const children = tui.children;` and the deleted line was line 86. But that contradicts the "around line 85" if we think about it.

Actually, "around line 85" in the current file, line 85 is `const children = tui.children;`. The deleted line was likely the line immediately after this, which is now line 86 - `children.splice(children.length - 1, 0, userMessage);`. But that line isn't deleted.

Wait, the current line 86 is `children.splice(children.length - 1, 0, userMessage);`. This line references `userMessage` which is undefined. So `userMessage` was defined on some line that was deleted. The deleted line must be between the current line 83 and line 85, or between line 85 and line 86.

Given the line numbers, if the deleted line was originally after line 85, then it would be the line that was between `const children = tui.children;` and `children.splice(children.length - 1, 0, userMessage);`.

But wait, if `const children = tui.children;` is line 85 and `children.splice` is line 86, then the deleted line would have been between them. That would mean the current line numbers have shifted by 0 from the original. So the deleted line was around line 85-86 in the original.

Actually, I think the original had:
```
85:    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
86:    const children = tui.children;
87:    children.splice(children.length - 1, 0, userMessage);
```

Or:
```
85:    const children = tui.children;
86:    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
87:    children.splice(children.length - 1, 0, userMessage);
```

Both are "around line 85". The question is which one is correct.

Given the `botMessage` pattern where the component is created right before its splice:
```ts
      const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
      children.splice(children.length - 1, 0, botMessage);
```

I think the most consistent pattern is:
```ts
    const children = tui.children;
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
    children.splice(children.length - 1, 0, userMessage);
```

But this is also possible:
```ts
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
    const children = tui.children;
    children.splice(children.length - 1, 0, userMessage);
```

I'll go with inserting after `const children = tui.children;` because that matches the `botMessage` pattern more closely. But actually, `botMessage` is defined right before its splice, so it could also be after `const children`.

Hmm, I think there's another clue. The current line 85 says `const children = tui.children;`. If the deleted line was after it, then the original line 85 was the same and line 86 was deleted. But if the deleted line was before it, then `const children` was originally line 86.

Given that "around line 85" points to line 85 itself, and the issue is that `userMessage` is undefined on line 86, the deleted line was likely the line that defined `userMessage`. The user says "around line 85" not "around line 86". So maybe the deleted line was line 85 or just before it.

I think I'll insert it after line 83 (before line 85), because:
1. The `isResponding` and `editor.disableSubmit` are state changes
2. Then creating the message component is the next logical step
3. Then getting children and splicing

This also matches the top-level organization where the slash commands create their messages/actions before manipulating children.

But wait, for the `botMessage` it's created right before its splice. So maybe:
```ts
    const children = tui.children;
    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
    children.splice(children.length - 1, 0, userMessage);
```

I'll insert it after line 85. This is the most natural pattern given the `botMessage` example. Let me make the edit.
</thinking>

.
<invoke name="edit">
	<parameter name="input">
¶chat-simple.ts#2371
insert after 85:
+    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
</parameter>
</invoke>


### Tool Result: edit
```
¶chat-simple.ts#5603
 84:
 85:    const children = tui.children;
+86:    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
 87:    children.splice(children.length - 1, 0, userMessage);
 88:
```

## Assistant

<thinking>
The edit was applied. Let me verify the file looks correct by reading the relevant section.
</thinking>

.
<invoke name="read">
	<parameter name="path">chat-simple.ts:80-95</parameter>
</invoke>


### Tool Result: read
```
¶chat-simple.ts#5603
79:  }
80:
81:  if (trimmed) {
82:    isResponding = true;
83:    editor.disableSubmit = true;
84:
85:    const children = tui.children;
86:    const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);
87:    children.splice(children.length - 1, 0, userMessage);
88:
89:    const loader = new Loader(
90:      tui,
91:      (s) => chalk.cyan(s),
92:      (s) => chalk.dim(s),
93:      'Thinking...',
94:    );
95:    children.splice(children.length - 1, 0, loader);
96:
97:    tui.requestRender();
98:

[Showing lines 79-98 of 131. Use :99 to continue]
```

## Assistant

<thinking>
The deleted statement `const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);` has been restored at line 86, right after `const children = tui.children;` and before the splice that references `userMessage`. The code now compiles logically and follows the same pattern as `botMessage` further down. The task is complete.
</thinking>

Done. The deleted statement `const userMessage = new Markdown(trimmed, 1, 1, defaultMarkdownTheme);` has been restored at line 86, directly before its use on the next line.
