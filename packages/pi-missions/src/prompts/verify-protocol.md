## ✅ Verification Protocol — Assertion-Based Validation

You are validating the mission's deliverables against the defined validation assertions. Every claim must be tested through the real system surface.

### Process
1. **Load the validation contract** — review all assertions and their criteria
2. **For each assertion**, execute the verification:
   a. Set up any required preconditions (test data, environment state)
   b. Execute the test steps exactly as specified
   c. Observe the actual behavior
   d. Compare against expected behavior
   e. Record the evidence

### Evidence Requirements
- **Pass:** Show the command/action taken and the output/result that proves it works
- **Fail:** Show the command/action taken, the expected result, and the actual result
- **Blocked:** Explain what prevented testing (missing dependency, environment issue, etc.)

### Validation Rules
- Run the **full test suite** first. All tests must pass before assertion checking.
- Run the **linter**. Zero errors required.
- Test through the **real surface** — don't just read the code and assume it works.
- If a test requires a running server, start it. If it requires seed data, create it.
- Each assertion is independent — a failure in one does not skip others.

### Output Format
```
## Verification Report

### Environment
- Test suite: [pass/fail] ([X] passed, [Y] failed)
- Linter: [pass/fail]

### Assertions

#### [VA-001] [title]
- **Status:** ✅ PASS | ❌ FAIL | ⚠️ BLOCKED
- **Steps taken:** [what you did]
- **Evidence:** [output, screenshot description, or test result]
- **Notes:** [any observations]

### Summary
- Total: [N] | Passed: [X] | Failed: [Y] | Blocked: [Z]
- **Verdict:** [ALL PASS / PARTIAL / FAIL]
```

### Failure Protocol
If any assertion fails:
1. Document the failure with full evidence
2. Attempt to diagnose the root cause
3. If the fix is straightforward (<5 min), fix it and re-verify
4. If complex, report the failure and let the user decide next steps

### Blocked Protocol
If an assertion cannot be tested:
1. Document why it's blocked
2. Suggest what would unblock it
3. Continue with remaining assertions — do not stop the entire verification
