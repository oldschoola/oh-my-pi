{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
Creates or overwrites file at specified path.
<conditions>
Creating new files explicitly required by task
Replacing entire file contents when editing would be more complex
Supports `.tar`, `.tar.gz`, `.tgz`, & `.zip` archive entries via `archive.ext:path/inside/archive`
Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
<critical>
For modifying existing files, the Edit tool is more precise & preserves formatting — `write` overwrites the file wholesale.
Don't create documentation files (`*.md`, README) unless the task explicitly asks for them.
Don't use emojis unless asked.