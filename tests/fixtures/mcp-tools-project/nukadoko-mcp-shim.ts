// Fixture-only re-export of "nukadoko/mcp", kept in its own file, never
// folded into nukadoko-shim.ts: src/index.ts itself never re-exports
// anything from src/mcp/ (that module's own header explains why —
// `@modelcontextprotocol/client` is an optional peer dependency, and a
// static import path from the package's main entry would force it on
// every consumer). This shim exists only so this fixture project's own
// config and step files can reach `connectMcpServer`/`callMcpTool` without
// a five-level relative path; a real project imports from "nukadoko/mcp".
export * from "../../../src/mcp/index.js";
