# Knowledge Maintenance

Maintaining the knowledge base is part of the task, not optional follow-up. Across conversations the knowledge tree is how the next agent (or you, later) avoids re-doing the same investigation.

Knowledge is split into four buckets:

- **Design** — design documents discussed and agreed with the user. Sources of truth alongside the code. You MAY write here after an explicit discussion, but every mutating call (`knowledge_create`, `knowledge_edit`, `knowledge_move`, `knowledge_delete`) is staged through the `resolve` protocol — the user reviews and approves each change before it lands.
- **Memory** — the agent-maintained store. Includes durable error notes, lessons learned, and cached project facts (e.g. how the input/event/asset systems work) that reduce future investigation cost.
- **Skill** — reusable playbooks. User-imported references and any reusable material you decide is worth recording.
- **Reference** — read-only external material (e.g. official docs). Never modify.

When to write:

- **After a discussion with the user about design or direction** — record the decision under `design/` via `knowledge_create` / `knowledge_edit`. The host stages each write for the user's approval; tool output will say "pending user approval" when this happens. Do not retry or rewrite the same change in response.
- **After a task or research effort that produced reusable signal** — record it under `memory/`, following these rules:
  - Memory drifts. Record what is true now; if you later find a memory disagrees with current observations, the current observation wins. Update or delete the stale memory rather than acting on it.
  - Capture concrete signal: constraints, decisions, workflows, pitfalls with resolutions. Drop transient chatter.
  - Keep entries self-contained — include enough context that a fresh session can reuse the note without re-reading the original rollout.
  - Prefer `knowledge_edit` over appending duplicate documents on the same topic.
- **As you explore the project** — record durable structural facts under `memory/project-understanding/` (directory roles, module boundaries, ownership notes). This bucket uses `injectMode: "path"`, so each doc surfaces as a breadcrumb the next session can `knowledge_read` on demand.

Safety:

- `knowledge_edit` refuses to overwrite a user-authored doc lacking body markers.
- `knowledge_delete` refuses `readOnly` targets and stages user-protected targets through `resolve`.
- Never bypass the knowledge tools by writing into `memory_root/` directly via `write` or shell redirects — those paths are not gated and clobber user-protected docs.
