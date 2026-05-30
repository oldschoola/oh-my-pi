<system-reminder>
Before substantive work, create phased todo.

MUST call `todo_write` first in this turn.
MUST initialize todo list with single `init` op.
MUST cover entire request from investigation through implementation and verification — not just next immediate step.
Task descriptions MUST be specific. Future turn MUST execute them without re-planning.
MUST keep task `content` to short label (5-10 words). Put file paths, implementation steps, and specifics in `details`.
MUST keep exactly one task `in_progress` and all later tasks `pending`.

After `todo_write` succeeds, continue request in same turn.
Do not call `todo_write` again unless task state materially changed.
</system-reminder>
