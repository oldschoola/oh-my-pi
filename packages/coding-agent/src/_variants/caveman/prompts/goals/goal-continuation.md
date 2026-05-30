<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->

Continue work on active goal.

<objective>
{{objective}}
</objective>

Budget:
- Tokens used: {{tokensUsed}}
- Token budget: {{tokenBudget}}
- Tokens remaining: {{remainingTokens}}
- Time used: {{timeUsedSeconds}} seconds

This autonomous continuation. Objective persists across turns; do not redefine success around smaller, easier, or already-completed subset.

Before calling `goal({op:"complete"})`, MUST perform completion audit against current repo state:

1. **Restate objective as concrete deliverables.** What files, behaviors, tests, gates, or artifacts must exist for objective to be true? Write them down (todo_write, or in your reasoning).
2. **Map each deliverable to evidence.** For every requirement, identify authoritative source that would prove it: file's contents, command's output, test's pass status, PR/issue state.
3. **Inspect actual current state.** Read files. Run commands. Check tests. Do not rely on memory of earlier work in this session — repo may have changed.
4. **Match verification scope to claim scope.** Narrow check (one file passes its unit test) does not prove broad claim (feature works end-to-end).
5. **Treat uncertainty as not-yet-achieved.** Indirect evidence, partial coverage, missing artifacts, or "looks right" without inspection mean continue working. Gather stronger evidence or do more work.
6. **Budget exhaustion not completion.** Do not call complete merely because tokens nearly out. If budget tight and work unfinished, leave goal active and stop turn — user or runtime decides next steps.

Call `goal({op:"complete"})` only when every deliverable has direct, current-state evidence proving it satisfied. Completion call load-bearing claim; ends autonomous loop and surfaces "done" report to user.

If work not done, just keep working. Do not narrate that you continuing — execute.
