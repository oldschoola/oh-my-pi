Search hidden tool metadata to discover and activate tools.

Activate hidden tools (MCP and built-in) when needing capability not in your active tool set.
{{#if hasDiscoverableMCPServers}}Discoverable MCP servers in this session: {{#list discoverableMCPServerSummaries join=", "}}{{this}}{{/list}}.{{/if}}
{{#if discoverableMCPToolCount}}Total discoverable tools available: {{discoverableMCPToolCount}}.{{/if}}
Input:
- `query` — required natural-language or keyword query
- `limit` — optional maximum number of tools to return and activate (default `8`)

Behavior:
- Searches hidden tool metadata using BM25-style relevance ranking
- Matches against tool name, label, server name, description/summary, and input schema keys
- Activates top matching tools for rest of current session
- Repeated searches add to active tool set; they do not remove earlier selections
- Newly activated tools become available before next model call in same overall turn

Notes:
Start with `limit` 5–10 if unsure.
- `query` matched against tool metadata fields:
  - `name`
  - `label`
  - `server_name` (MCP tools)
  - `mcp_tool_name` (MCP tools)
  - `description` / `summary`
  - input schema property keys (`schema_keys`)

Not for repository/file/code search. Tool discovery only.

Returns JSON with:
- `query`
- `activated_tools` — tools activated by this search call
- `match_count` — number of ranked matches returned by search
- `total_tools`
