Searches files using powerful regex matching.

<instruction>
- Supports Rust regex syntax (RE2-style — no lookaround or backreferences). Use line anchors or post-filters instead of (?!…)/(?<!…)
- `paths` is required and accepts either one string or an array of files, directories, globs, or internal URLs
- For multiple targets, pass an array with one target per element. Don't comma-join targets inside one string: pass `["src", "tests"]`, not `"src,tests"` or `["src,tests"]`.
- Cross-line patterns are detected from literal `\n` or escaped `\\n` in `pattern`
</instruction>

<output>
{{#if IS_HL_MODE}}
- Text output emits a file snapshot tag header per matched file plus numbered lines: `¶src/login.ts#1f`, `*42:if (user.id) {` (match), ` 43:return user;` (context). Copy the header for anchored edits; ops use bare line numbers.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
</output>

<critical>
- For content search, the built-in `search` tool is the path that works. Shelling out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, or `sed`-for-search via Bash loses `.gitignore` semantics, bypasses result limits, and skips the structural headers other tools rely on — even for a single match, even "just to check quickly".
- If you catch yourself typing `grep`, `rg`, or `| grep` in a Bash command, switch to `search` instead — it's faster and already wired into the workspace.
- For open-ended searches requiring multiple rounds, use the Task tool with the explore subagent rather than chaining `search` calls yourself.
</critical>
