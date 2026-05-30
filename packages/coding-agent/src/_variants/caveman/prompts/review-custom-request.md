## Code Review Request

### Mode

Custom review instructions

### Distribution Guidelines

Use `task` tool with `agent: "reviewer"` and `tasks` array.
Make exactly **1 reviewer task**. Assignment must include custom instructions below.

### Reviewer Instructions

Reviewer MUST:
1. Follow custom instructions below
2. Read referenced files or workspace context needed to evaluate them
3. Call `report_finding` per issue
4. Call `yield` with verdict when done

### Custom Instructions

{{instructions}}
