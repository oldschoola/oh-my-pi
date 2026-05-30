Finds files and directories using fast pattern matching that works with any codebase size.

<instruction>
- `paths` required; takes array of globs, files, or directories
- Pass multiple targets as **separate array elements** (`paths: ["a", "b"]`), NEVER as single comma-joined string (`paths: ["a,b"]` rejected)
- `gitignore` defaults to `true` and hides files matched by `.gitignore`. Set `gitignore: false` to find `.env*`, `*.log`, freshly-created build outputs, or anything else repo ignores
- `hidden` defaults to `true`; combine with `gitignore: false` to surface dotfiles also gitignored
- `limit` clamped to 1-200 (default 200). Narrow pattern instead of raising limit
- `timeout` in seconds (default 5, clamped to 0.5–60). On timeout, find returns whatever partial matches collected with `truncated: true` and notice — increase `timeout` or narrow pattern instead of retrying blindly
- SHOULD perform multiple searches in parallel when potentially useful
</instruction>

<output>
Matching file and directory paths sorted by modification time (most recent first), grouped by directory to reduce token usage. Each group starts with `# <dir>/` followed by basenames (one per line); directory entries get trailing `/`. Root-level entries have no header. Truncated at 200 entries or 50KB.
</output>

<examples>
# Find files
`{"paths": ["src/**/*.ts"]}`
# Multiple targets — separate array elements
`{"paths": ["src/**/*.ts", "test/**/*.ts"]}`
# Find gitignored files like .env
`{"paths": [".env*"], "gitignore": false}`
# Find directories matching a name (returns both files and dirs; directories are suffixed with `/`)
`{"paths": ["**/tests"]}`
# Long-running search on a slow volume
`{"paths": ["/Volumes/Storage/**/*.py"], "timeout": 30}`
</examples>

<avoid>
For open-ended searches requiring multiple rounds of globbing and searching, MUST use Task tool instead.
</avoid>

<critical>
- MUST use built-in Find tool for every file-name lookup. NEVER shell out to `find`, `fd`, `locate`, `ls`, or `git ls-files` via Bash — they ignore `.gitignore`, blow past result limits, and waste tokens.
- If you catch yourself typing `find -name`, `fd`, or `ls **/*.ext` in Bash command, stop and re-issue lookup through Find tool with glob pattern instead.
</critical>
