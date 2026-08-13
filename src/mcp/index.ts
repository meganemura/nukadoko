// Responsibility: the "nukadoko/mcp" package surface (docs/spec.md "MCP
// servers") — a hand-written typed step's own way to call a tool an
// ordinary MCP server declares over stdio, in a separate process. Never
// imported by src/index.ts, and never imported anywhere on the path from
// `src/cli.ts` to a command's own dispatch (src/cli/run-cli.ts): unlike
// Playwright, `@modelcontextprotocol/client` is a peer dependency, optional
// for a project that never touches this surface, and a static import
// anywhere on that path would make loading nukadoko itself, or running
// `nuka check` on a project with no MCP fixture at all, depend on a
// package that project never installed. The one CLI command that does need
// it, `nuka mcp-tools`, reaches src/mcp/list-tools.ts through a dynamic
// `import()` inside its own handler instead (src/cli/mcp-tools.ts), for
// exactly that reason.
//
// Which MCP protocol era a connection speaks (connect.ts's own header) is
// `@modelcontextprotocol/client`'s own `versionNegotiation` setting to
// decide. `connectMcpServer` passes a caller's `StdioServerParameters`
// straight to its own transport and a caller's own `ClientOptions` straight
// to `Client`'s own constructor, both unread. Left out, the client
// package's own default applies: the plain 2025 connect sequence, no
// probe, no new headers. A caller reaching for the 2026-07-28 handshake
// asks for it through that same `clientOptions` argument, not through
// anything pinned by this package.

export { connectMcpServer } from "./connect.js";
export { callMcpTool, type McpToolCallResult } from "./call-tool.js";
