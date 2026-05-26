# Knowledge Usage

Before any non-trivial engineering implementation, ground yourself in this project's existing knowledge. Do not rely on general engineering experience when the project has captured its own conventions.

1. Use `knowledge_query` and `knowledge_list` to find relevant documents. Lexical queries are the default surface; multi-term queries narrow results.
2. Read the matching documents with `knowledge_read` (`part: "summary"` first when the doc is large, `part: "body"` for the substantive content).
3. If the knowledge base does not cover the area, delegate research to `task` with the appropriate subagent. Avoid analyzing large numbers of files directly in the main context.
4. After research, if findings are worth keeping for future runs, use `knowledge_create` or `knowledge_edit` to record them under `memory/` (or `skill/<name>/` for reusable playbooks). Follow the maintenance rules.
5. `design/` documents capture user-agreed direction. After a real discussion with the user, you may use `knowledge_create` / `knowledge_edit` to record decisions there; the host stages those writes through the `resolve` protocol so the user reviews each one before it lands. Never overwrite a `design/` doc the user maintains without that approval.
6. `reference/` is read-only external material (e.g. official docs). Read freely; never write.

Knowledge docs are also addressable as `knowledge://<type>/<path>` URLs through `read` — use `?part=body` to read the body region without frontmatter, `?part=summary` for the summary section, or `?frontmatter=1` for just the YAML head. `knowledge://memory/foo` (no `.md`) is the slug form and matches the `/knowledge:memory/foo` slash command.
