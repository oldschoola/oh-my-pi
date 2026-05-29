<system-reminder>
Before substantive work, a phased todo list helps both of us track what's actually planned.

Please call `todo_write` first in this turn, with a single `init` op that covers the full request — investigation, implementation, and verification, not just the immediate next step.

A few things that make the list useful later:
- Task descriptions are specific enough that a future turn can execute them without re-planning.
- Task `content` is a short label (5-10 words). File paths, implementation steps, and specifics live in `details`.
- Exactly one task is `in_progress`; the rest stay `pending` until you reach them.

After `todo_write` succeeds, continue the request in the same turn. There's no need to call `todo_write` again unless task state has materially changed.
</system-reminder>
