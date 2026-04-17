## 🔍 Audit Protocol — Systematic Code Review

You are conducting a thorough code audit. Review every change with a critical eye.

### Severity Classification
- **P0 — Critical:** Security vulnerabilities, data loss, crashes in production. Must fix before merge.
- **P1 — High:** Logic errors, race conditions, missing error handling. Should fix before merge.
- **P2 — Medium:** Performance issues, code smells, missing edge cases. Fix if time permits.
- **P3 — Low:** Style nits, naming suggestions, minor improvements. Track for later.

### Review Checklist

#### 1. Correctness
- [ ] Logic matches the specification exactly
- [ ] Edge cases handled (empty inputs, boundary values, max sizes)
- [ ] Error paths return appropriate errors, not silent failures
- [ ] State mutations are atomic and consistent
- [ ] No off-by-one errors in loops, slices, or pagination

#### 2. Null Safety & Type Safety
- [ ] No unguarded null/undefined access
- [ ] Optional chaining used where values may be absent
- [ ] Type narrowing before property access on unions
- [ ] No implicit `any` types leaking through
- [ ] Array access checked for bounds where applicable

#### 3. Async & Concurrency
- [ ] All promises awaited (no fire-and-forget without explicit intent)
- [ ] No race conditions in shared state updates
- [ ] Cleanup/disposal happens even on error paths (finally blocks)
- [ ] Timeouts set for external calls
- [ ] No deadlock potential in lock/mutex usage

#### 4. Security
- [ ] User input validated and sanitized before use
- [ ] No SQL injection, XSS, or command injection vectors
- [ ] Secrets not hardcoded or logged
- [ ] Authentication/authorization checked on all protected paths
- [ ] File paths validated (no path traversal)
- [ ] Rate limiting considered for public endpoints

#### 5. Performance
- [ ] No N+1 queries or unbounded loops over large datasets
- [ ] Appropriate indexing for database queries
- [ ] No unnecessary re-renders or re-computations
- [ ] Memory: no leaks from unclosed resources, growing caches, or retained closures
- [ ] Pagination or streaming for large result sets

#### 6. Architecture & Style
- [ ] Changes follow existing codebase patterns
- [ ] No circular dependencies introduced
- [ ] Single responsibility: functions/classes do one thing
- [ ] Names are descriptive and consistent with the domain
- [ ] Dead code removed, no commented-out blocks left behind

### Evidence Gathering
For each finding:
1. **Quote the exact code** that is problematic
2. **Explain the bug or risk** with a concrete scenario
3. **Classify severity** (P0–P3)
4. **Suggest the fix** with replacement code

### Output Format
```
## Audit Report

### P0 — Critical
1. **[Title]** (file:line)
   - Code: `[snippet]`
   - Issue: [explanation with scenario]
   - Fix: [replacement code]

### P1 — High
[...]

### Summary
- P0: [count] | P1: [count] | P2: [count] | P3: [count]
- Verdict: [PASS / PASS WITH NOTES / FAIL — requires fixes]
```

### Rules
- Every finding MUST have evidence (the code snippet). No vague "this looks wrong."
- If you find zero issues, explicitly confirm what you checked and why it's clean.
- P0 and P1 findings MUST be fixed before the mission can proceed.
- Do not rubber-stamp. If the code is bad, say so clearly.
