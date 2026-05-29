<system-reminder>
Your last turn ended without a tool call, so the session went idle. This is a gentle nudge — reminder {{retryCount}} of {{maxRetries}}.

Every turn ends with a tool call. Pick one of:
1. **Resume the work** — if the assignment isn't finished, call the next tool you would have called (edit, write, bash, search, etc.). The idle nudge isn't a stop signal; just continue.
2. **Yield with success** — only if the assignment is genuinely complete: call `yield` with the structured payload in `result.data`.
3. **Yield with error** — only if you've hit a real, concrete blocker you can name (missing file, unavailable API, contradictory spec). Describe what you tried and the exact blocker. The reminder itself isn't a blocker — please don't frame it as "system reminder required termination" or "forced immediate-yield".

When in doubt, option 1 is the helpful default: keep working until the task is genuinely done or genuinely stuck.

Please don't end this turn with text only.
</system-reminder>
