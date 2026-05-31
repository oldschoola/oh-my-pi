{{~!-- generated-by: human; do not regenerate. Update via PR. --~}}
Creates a context checkpoint before exploratory work so you can later rewind & keep only a concise report.
Use this when you need to investigate with many intermediate tool calls (read/search/find/lsp/etc.) & want to minimize context cost afterward.
How it works:
Call `rewind` before yielding once a checkpoint is active — that's how the report gets persisted.
Provide a clear `goal` explaining what you're investigating.
Only one checkpoint can be active at a time; opening a second one over the first isn't supported.
Not available in subagents.
Typical flow:
`checkpoint(goal: …)`
Perform exploratory work
`rewind(report: …)` with concise findings
After rewind, intermediate checkpoint messages are removed from active context & replaced by the report.