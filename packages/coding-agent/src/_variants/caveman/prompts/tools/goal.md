{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
Manage the active goal-mode objective.
Use a single `op` field:
`create` starts a goal. Requires `objective`; optional `token_budget` must be positive. Use only when no goal exists & no goal is paused.
`get` returns the current goal (active or paused) & remaining token budget.
`resume` re-activates a paused goal so work can continue.
`complete` marks the goal complete after you've verified every deliverable against current evidence.
`drop` discards the current goal without completing it.
Examples:
`goal({"op":"create","objective":"Implement feature X","token_budget":50000})`
`goal({"op":"get"})`
`goal({"op":"resume"})`
`goal({"op":"complete"})`
`goal({"op":"drop"})`
A low budget or an ending turn isn't a reason to call `complete` — call it only when the goal is actually done & verified.
If `get` shows a paused goal, call `resume` before continuing work on it.