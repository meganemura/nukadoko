This fixture project exists for `nuka mcp-tools`, `nuka steps`, and
`callMcpTool`, not for a scenario that actually runs: there is no
`.feature` file here. `steps/` holds one real step
(calls-mcp-tool-step.ts) that reaches an MCP server exclusively through the
`mcpClient` fixture (nukadoko.config.ts), so `nuka steps --json` has real
vocabulary to check needs_browser and the MCP tool's own absence from it
against.
