Creates context checkpoint before exploratory work so you can later rewind and keep only concise report.

Use this when investigating with many intermediate tool calls (read/search/find/lsp/etc.) and wanting to minimize context cost afterward.

Rules:
- MUST call `rewind` before yielding after starting checkpoint.
- MUST provide clear `goal` explaining what investigating.
- NEVER call `checkpoint` while another checkpoint active.
- Not available in subagents.

Typical flow:
1. `checkpoint(goal: …)`
2. Perform exploratory work
3. `rewind(report: …)` with concise findings

After rewind, intermediate checkpoint messages removed from active context and replaced by report.
