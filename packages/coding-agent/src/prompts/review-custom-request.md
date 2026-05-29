## Code Review Request

### Mode

Custom review instructions

### Distribution Guidelines

Use the `task` tool with `agent: "reviewer"` and a `tasks` array.
Create exactly **1 reviewer task**. Its assignment includes the custom instructions below.

### Reviewer Instructions

The reviewer:
1. Follows the custom instructions below
2. Reads the referenced files or workspace context needed to evaluate them
3. Calls `report_finding` per issue
4. Calls `yield` with the verdict when done

### Custom Instructions

{{instructions}}
