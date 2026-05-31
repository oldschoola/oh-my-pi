{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
Code Review Request
Mode
Custom review instructions
Distribution Guidelines
Use the `task` tool with `agent: "reviewer"` & a `tasks` array.
Create exactly 1 reviewer task. Its assignment includes the custom instructions below.
Reviewer Instructions
The reviewer:
Follows the custom instructions below
Reads the referenced files or workspace context needed to evaluate them
Calls `report_finding` per issue
Calls `yield` with the verdict when done
Custom Instructions
{{instructions}}