Searches files using powerful regex matching.

<instruction>
- Supports Rust regex syntax (RE2-style — no lookaround or backreferences). Use line anchors or post-filters instead of (?!…)/(?<!…)
- `paths` required; takes either one string or array of files, directories, globs, or internal URLs
- For multiple targets, pass array with one target per element. Do not comma-join targets inside one string: pass `["src", "tests"]`, not `"src,tests"` or `["src,tests"]`.
- Cross-line patterns detected from literal `\n` or escaped `\\n` in `pattern`
</instruction>

<output>
{{#if IS_HL_MODE}}
- Text output emits file snapshot tag header per matched file plus numbered lines: `¶src/login.ts#1f`, `*42:if (user.id) {` (match), ` 43:return user;` (context). Copy header for anchored edits; ops use bare line numbers.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output line-number-prefixed
{{/if}}
{{/if}}
</output>

<critical>
- MUST use built-in `search` tool for any content search. NEVER shell out to `grep`, `rg`, `ripgrep`, `ag`, `ack`, `git grep`, `awk`, `sed`-for-search, or any other CLI search via Bash — even for single match, even "just to check quickly", even piped through other commands.
- Bash `grep`/`rg` loses `.gitignore` semantics, bypasses result limits, and wastes tokens. `search` tool faster, structured, and already wired into workspace — no scenario where Bash search preferable.
- If you catch yourself typing `grep`, `rg`, or `| grep` in Bash command, stop and re-issue lookup through `search` tool instead.
- If search open-ended, requiring multiple rounds, MUST use Task tool with explore subagent instead of chaining `search` calls yourself.
</critical>
