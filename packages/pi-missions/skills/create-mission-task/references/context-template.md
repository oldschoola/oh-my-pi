# CONTEXT.md Template (Slim)

This is the recommended format for domain/platform CONTEXT.md files.
Intentionally slim — this gets loaded into agent context for every task in this area.
Each area's CONTEXT.md path is registered in `.omp/mission.json → task_areas`.

**Design principles:**
- Current state only, not history (history is in `tasks/archive/`)
- No task lists (visible from folder structure: `tasks/` = active, `tasks/archive/` = done)
- Key files are paths only, not descriptions
- Tech debt is a living list that agents add to during execution

---

```markdown
# [Domain/Platform Name] — Context

**Last Updated:** YYYY-MM-DD  
**Status:** Active | Stable | Complete  
**Next Task ID:** [PREFIX]-001

---

## Current State

[What exists TODAY — 2-3 paragraphs max. Focus on current capabilities,
architectural decisions, and known constraints. Not history.]

---

## Key Files

| Category | Path |
|----------|------|
| Service | `services/{service}/` |
| API Spec | `docs/api/{service}-api.md` |
| Data Model | `docs/data-models/{service}-collections.md` |
| Tests | `services/{service}/tests/` |
| [Other] | [path] |

---

## Technical Debt / Future Work

Items identified during implementation but not yet converted to tasks.
Agents add to this list under self-documentation standing instructions.

- [ ] **[Item name]** — Description (discovered during [PREFIX-###])
- [ ] **[Item name]** — Description (discovered during [PREFIX-###])
```

---

## Notes

### Why No Task Lists?

Open tasks are visible in `tasks/` folder. Completed tasks are in `tasks/archive/`.
Duplicating this in CONTEXT.md creates sync overhead and stale data.

### Next Task ID Counter

When creating a new task:
1. Read `Next Task ID` (e.g., `TO-016`)
2. Use that ID for the new task folder
3. Increment the counter (e.g., `TO-017`) in the same edit

This avoids scanning folder structures for the next available number.

### When to Update CONTEXT.md

| Trigger | What to Update |
|---------|---------------|
| Feature shipped | Current State section |
| Tech debt discovered | Technical Debt section |
| Architecture decision made | Current State section |
| Key file moved/renamed | Key Files section |
| Task created | Next Task ID counter |
