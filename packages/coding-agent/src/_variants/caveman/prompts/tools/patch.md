{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
Patches files given diff hunks. Primary tool for existing-file edits.
<instruction>
Hunk Headers:
`@@` — bare header when context lines are unique
`@@ $ANCHOR` — anchor copied verbatim from file (full line or unique substring)
Anchor Selection:
Otherwise pick a highly specific anchor copied from the file:
- full function signature
- class declaration
- unique string literal/error message
- config key with uncommon name
On "Found multiple matches": add context lines, use multiple hunks with separate anchors, or use a longer anchor substring
Context Lines:
Include enough ` `-prefixed lines to make the match unique (usually 2-8)
When editing structured blocks (nested braces, tags, indented regions), include opening & closing lines so the edit stays inside the block
<parameters>
```ts
// Input is { path: string, edits: Entry[] }. `path` is required and applies to every entry.
type Entry =
   // Diff is one or more hunks for the top-level path.
   // - Each hunk begins with "@@" (anchor optional).
   // - Each hunk body only has lines starting with ' ' | '+' | '-'.
   // - Each hunk includes at least one change (+ or -).
   | { op: "update", diff: string }
   // Diff is full file content, no prefixes.
   | { op: "create", diff: string }
   // No diff for delete.
   | { op: "delete" }
   // New path for update+move from the top-level path.
   | { op: "update", rename: string, diff: string }
```
<output>
Returns success/failure; on failure, error message indicates:
"Found multiple matches" — anchor/context not unique enough
"No match found" — context lines don't exist in file (wrong content or stale read)
Syntax errors in diff format
<critical>
Read the target file before editing — the patch has to match the bytes on disk, not a recollection of them.
Copy anchors & context lines verbatim, including whitespace; tabs vs spaces really matter here.
Anchors are match strings, not comments — don't use line numbers, location labels, or placeholders like `@@ @@`.
Keep new lines inside the intended block; if context lets them drift, tighten the anchor.
If an edit fails or breaks structure, re-read the file & build a new patch from the current bytes. Resubmitting the same diff just produces the same failure.
For indentation, whitespace, or reformatting, leave it to the formatter (`bun fmt`, `cargo fmt`, `prettier --write`, …) at the end. One pass fixes all of it; N individual edits don't.
<examples>
Create
`edit {"path":"hello.txt","edits":[{"op":"create","diff":"Hello\n"}]}`
Update
`edit {"path":"src/app.py","edits":[{"op":"update","diff":"@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n"}]}`
Rename
`edit {"path":"src/app.py","edits":[{"op":"update","rename":"src/main.py","diff":"@@\n …\n"}]}`
Delete
`edit {"path":"obsolete.txt","edits":[{"op":"delete"}]}`
Multiple entries
All entries in one call apply to the top-level `path`; use separate calls for different files.
<avoid>
Generic anchors: `import`, `export`, `describe`, `function`, `const`
Repeating the same addition in multiple hunks (duplicate blocks)
Full-file overwrites for minor changes (acceptable for major restructures or short files)