<system-reminder>
Last turn ended without tool call, so session went idle. This is reminder {{retryCount}} of {{maxRetries}}.

Every turn MUST end with tool call. Pick exactly one of:
1. **Resume work** — if assignment not finished, call next tool you would have called (edit, write, bash, search, etc.). NEVER yield. NEVER treat this reminder as forced stop.
2. **Yield with success** — only if assignment genuinely complete: call `yield` with structured payload in `result.data`.
3. **Yield with error** — only if you hit real, concrete blocker you can name (missing file, unavailable API, contradictory spec). Describe what you tried and exact blocker. NEVER fabricate "forced immediate-yield" or "system reminder required termination" reason — this reminder is not a blocker.

Default to option 1 unless work actually done or actually blocked.

NEVER end this turn with text only.
</system-reminder>
