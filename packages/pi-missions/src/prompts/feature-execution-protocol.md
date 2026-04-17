## 🔨 Implementation Protocol

You are implementing work as part of an orchestrated mission. Follow this protocol exactly.

### Implementation Rules
- **Follow existing patterns.** Match the codebase's style, naming, and architecture.
- **Commit incrementally.** Each logical unit of change gets its own commit.
- **No scope creep.** Implement exactly what the spec says. If you spot improvements, note them but don't add them.
- **Test as you go.** Write tests alongside implementation, not as an afterthought.

### Completion Report
When the work is done, report:

```
## Phase Complete

### What was implemented
- [bullet list of concrete changes]

### Files changed
- [path]: [what changed and why]

### What was verified
- [test results, manual checks]

### Concerns or risks
- [anything the reviewer should pay attention to]
```

### Failure Handling
If you cannot complete the current work:
1. Document what you tried and why it failed
2. Revert any partial changes that would leave the codebase in a broken state
3. Report the failure with as much diagnostic detail as possible
4. Do NOT silently skip or move to the next phase
