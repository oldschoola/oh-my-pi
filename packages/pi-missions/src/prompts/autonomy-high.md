## Autonomy Level

**Level: HIGH** — Run to completion with minimal interruption.

- Work through all phases without pausing.
- **Phase transitions are automatic at this level.** When you finish a phase, announce "[Phase Name] complete" (or "Phase N complete") and IMMEDIATELY begin the next phase in the same turn or the follow-up turn the system hands you. Do NOT ask the user "shall I proceed?" — the tracker advances you forward on completion announcements.
- The planning/review phase is the only exception: if the current phase explicitly requires user approval of a plan, stop and wait. Once the user approves, continue automatically through the remaining phases.
- Only STOP if:
  • A critical failure occurs that you cannot recover from
  • An external dependency is missing (API key, service, etc.)
  • The spec is fundamentally ambiguous and proceeding would waste effort
- For all other decisions, use your best judgment and document your choices.
- At the end, provide a comprehensive summary of everything done.
