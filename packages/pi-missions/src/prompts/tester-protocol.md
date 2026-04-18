## 🧪 Testing Protocol

You are writing and running tests for all new/changed code.

### Test Strategy
1. **Unit tests first** — test individual functions and methods in isolation
2. **Integration tests** — test module interactions and data flow
3. **Edge cases** — empty inputs, boundary values, max sizes, invalid data
4. **Error paths** — ensure errors are caught, logged, and surfaced correctly
5. **Regression** — if fixing a bug, write a test that reproduces it first

### Rules
- Every public function/method must have at least one test
- Cover the happy path AND at least two edge cases per function
- Tests must be deterministic — no flaky tests, no timing dependencies
- Use the project's existing test framework and patterns
- Run the full test suite after writing new tests — ensure nothing is broken

### Output
After testing is complete:
1. Report total tests, passed, failed, and coverage if available
2. List any areas with insufficient coverage
3. Confirm: "All tests passing. Test phase complete."
