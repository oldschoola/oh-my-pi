Tasks are referenced by their verbatim content string, not by any auto-generated ID. There is no "task-1"/"task-N" identifier — the tool never emits one. Pass the task's content text in the `task` field.
Manages a phased task list. Pass `ops`: a flat array of operations.
The next pending task is auto-promoted to `in_progress` after each completion.
Allowed `op` values are only `init`, `start`, `done`, `drop`, `rm`, `append`, & `note`. `pending` is a task status, not an `op`; leave not-yet-started tasks implicit in `init`/`append` lists.
Operations
|__CAVEMAN_BLOCK_15__|Required fields|Effect|
|---|---|---|
|__CAVEMAN_BLOCK_16__|__CAVEMAN_BLOCK_17__|Initialize the full list (replaces any existing list)|
|__CAVEMAN_BLOCK_18__|__CAVEMAN_BLOCK_19__|Mark in progress|
|__CAVEMAN_BLOCK_20__|__CAVEMAN_BLOCK_21__ or __CAVEMAN_BLOCK_22__|Mark completed|
|__CAVEMAN_BLOCK_23__|__CAVEMAN_BLOCK_24__ or __CAVEMAN_BLOCK_25__|Mark abandoned|
|__CAVEMAN_BLOCK_26__|__CAVEMAN_BLOCK_27__ or __CAVEMAN_BLOCK_28__|Remove|
|__CAVEMAN_BLOCK_29__|__CAVEMAN_BLOCK_30__, __CAVEMAN_BLOCK_31__|Append tasks to __CAVEMAN_BLOCK_32__; lazily creates phase|
|__CAVEMAN_BLOCK_33__|__CAVEMAN_BLOCK_34__, __CAVEMAN_BLOCK_35__|Append a note to a task. Reminders for future-you only.|

Anatomy
Task content: 5-10 words, what is being done, not how. Used as the task identifier — unique.
Phase name: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`). Used as the phase identifier — unique. Don't add prefixes like `1.`, `A)`, `Phase 1:`, etc.
Rules
Mark tasks done as soon as they're finished — the next pending task only promotes once you do.
Work through phases in order; the list assumes that ordering.
On blockers, `append` a new task to the active phase to unblock yourself, or `drop` the blocked task.
`task` & `phase` fields reference content/name verbatim; keep them stable once introduced.
When to create a list
Task requires 3+ distinct steps
User explicitly requests one
User provides a set of tasks to complete
New instructions arrive mid-task — capture before proceeding
<examples>
Initial setup (multi-phase)
`{"ops":[{"op":"init","list":[{"phase":"Foundation","items":["Scaffold crate","Wire workspace"]},{"phase":"Auth","items":["Port credential store","Wire OAuth providers"]},{"phase":"Verification","items":["Run cargo test"]}]}]}`
Initial setup (single phase)
`{"ops":[{"op":"init","list":[{"phase":"Implementation","items":["Apply fix","Run tests"]}]}]}`
Complete one task
`{"ops":[{"op":"done","task":"Wire workspace"}]}`
Complete a whole phase
`{"ops":[{"op":"done","phase":"Auth"}]}`
Remove all tasks
`{"ops":[{"op":"rm"}]}`
Drop one task
`{"ops":[{"op":"drop","task":"Run cargo test"}]}`
Append tasks to a phase
`{"ops":[{"op":"append","phase":"Auth","items":["Handle retries","Run tests"]}]}`