Finds files & directories using fast pattern matching that works with any codebase size.
<instruction>
`paths` is required & accepts an array of globs, files, or directories
Pass multiple targets as separate array elements (`paths: ["a", "b"]`). A single comma-joined string (`paths: ["a,b"]`) is rejected.
`gitignore` defaults to `true` & hides files matched by `.gitignore`. Set `gitignore: false` to find `.env`, `.log`, freshly-created build outputs, or anything else your repo ignores
`hidden` defaults to `true`; combine with `gitignore: false` to surface dotfiles that are also gitignored
`limit` is clamped to 1-200 (default 200). Narrowing the pattern tends to work better than raising the limit
`timeout` is in seconds (default 5, clamped to 0.5-60). On timeout, find returns whatever partial matches it has collected with `truncated: true` & a notice — increase `timeout` or narrow the pattern rather than retrying blindly
Run multiple searches in parallel when independent — it's faster than serializing them
<output>
Matching file & directory paths sorted by modification time (most recent first), grouped by directory to reduce token usage. Each group starts with `# <dir>/` followed by basenames (one per line); directory entries get a trailing `/`. Root-level entries have no header. Truncated at 200 entries or 50KB.
<examples>
Find files
`{"paths": ["src//*.ts"]}`
Multiple targets — separate array elements
`{"paths": ["src//.ts", "test//.ts"]}`
Find gitignored files like .env
`{"paths": [".env*"], "gitignore": false}`
Find directories matching a name (returns both files & dirs; directories are suffixed with `/`)
`{"paths": ["/tests"]}`
Long-running search on a slow volume
`{"paths": ["/Volumes/Storage//*.py"], "timeout": 30}`
<avoid>
For open-ended searches requiring multiple rounds of globbing & searching, the Task tool is the better fit.
<critical>
For file-name lookups, the built-in Find tool is the path that works. Shelling out to `find`, `fd`, `locate`, `ls`, or `git ls-files` via Bash ignores `.gitignore`, blows past result limits, & wastes tokens.
If you catch yourself typing `find -name`, `fd`, or `ls /*.ext` in a Bash command, switch to the Find tool with a glob pattern instead.