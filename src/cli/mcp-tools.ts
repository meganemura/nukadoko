import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka mcp-tools -- <command> [args...]`'s CLI-facing
// wiring — connect to the given command as an MCP server over stdio, print
// whatever tools it declares, and disconnect. Kept out of run-cli.ts so it
// is unit-testable without going through yargs, the same split
// cli/webmcp.ts already follows.
//
// The one thing this file does that no other command's own CLI wiring
// needs to: `../mcp/list-tools.js` is reached through a dynamic `import()`
// inside runMcpTools() below, never a static import at this module's own
// top level. `@modelcontextprotocol/client` is an optional peer dependency
// (package.json), so a project that never touches this surface never
// installs it — a static import here would put that package on the load
// path of `src/cli/run-cli.ts`, which every `nuka` invocation goes
// through, and break every other command for a project that has no MCP
// fixture at all.

const CLIENT_SPECIFIER = "@modelcontextprotocol/client";
const CLIENT_VERSION = "2.0.0";

/**
 * `null` unless `error` is specifically the dynamic `import()` above
 * failing because `@modelcontextprotocol/client` itself is not installed —
 * Node's own `ERR_MODULE_NOT_FOUND`, naming that exact specifier. Checked
 * this narrowly on purpose: a broken `../mcp/list-tools.js` for any other
 * reason (a syntax error, an unrelated missing module one of its own
 * imports needs) must not be mislabeled as "the client package is missing"
 * and shown a misleading install command instead of its own real cause.
 */
export function formatClientMissingMessage(error: unknown): string | null {
  if (
    !(error instanceof Error) ||
    (error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(CLIENT_SPECIFIER)
  ) {
    return null;
  }
  return (
    `nuka mcp-tools needs "${CLIENT_SPECIFIER}" installed, and it is not: this package only lists it ` +
    `as an optional peer dependency, so a project that never uses this surface never pays for the ` +
    `packages it pulls in. Install the exact version this package was built against: ` +
    `npm install -D -E ${CLIENT_SPECIFIER}@${CLIENT_VERSION}`
  );
}

export interface RunMcpToolsOptions {
  /** The server's own executable, the first token after `--`; `undefined`
   * when `--` was never given, or given with nothing after it. */
  command: string | undefined;
  /** Every token after `--` other than `command` itself, passed to the
   * server's own process untouched. */
  args: readonly string[];
  json: boolean;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runMcpTools(options: RunMcpToolsOptions): Promise<number> {
  const { command, args, json, stdout, stderr } = options;
  if (command === undefined) {
    stderr.write(
      "nuka mcp-tools needs the server's own command after --, " +
        "e.g. `nuka mcp-tools -- node server.js`\n",
    );
    return 1;
  }

  try {
    const { listMcpTools } = await import("../mcp/list-tools.js");
    const tools = await listMcpTools({ command, args: [...args] });
    if (json) {
      stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
    } else {
      // Name and description only, per this surface's own decision to
      // leave `inputSchema` (verbose, meant to be read as JSON text) to
      // `--json` — the same split `nuka steps`/cli/webmcp.ts already make.
      for (const tool of tools) {
        stdout.write(`${tool.name}\t${tool.description ?? ""}\n`);
      }
    }
    return 0;
  } catch (error) {
    const clientMissing = formatClientMissingMessage(error);
    stderr.write(`${clientMissing ?? (error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}
