import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatSdkMissingMessage } from "../src/cli/mcp-tools.js";
import { runCli } from "../src/cli/run-cli.js";
import { callMcpTool } from "../src/mcp/call-tool.js";
import { connectMcpServer } from "../src/mcp/connect.js";
import { createCaptureSink, fixture, repoRoot, testsDir } from "./helpers/fixtures.js";

// Responsibility: this surface's own acceptance criteria, in one file. A
// real MCP server (tests/helpers/mcp-test-server.ts) spawned over stdio,
// A (`nuka mcp-tools`) listing its tools and B
// (connectMcpServer/callMcpTool, "nukadoko/mcp") calling one and reading
// back its result, plus `callMcpTool`'s own `isError` check throwing on a
// tool that reports an in-band failure, plus `connectMcpServer`'s own
// second, optional `ClientOptions` argument reaching `Client`'s own
// constructor rather than being silently dropped (a pinned
// `versionNegotiation` mode rejects against this server, which never
// implements `server/discover`; the same connect without that argument
// succeeds, which is what makes the rejection proof the argument
// arrived). A second describe block confirms `nuka steps --json` never
// lists an MCP tool as vocabulary and reports `needs_browser: false` for
// the one step here that reaches the server exclusively through a
// fixture. A third checks the CLI wiring's own client-package-missing
// detection directly, on a synthetic `ERR_MODULE_NOT_FOUND` rather than a
// real one: `@modelcontextprotocol/client` is always installed in this
// repo's own devDependencies, so a vitest run within this repo can never
// observe the real "not installed" case the detection exists for.

const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const serverScript = path.join(testsDir, "helpers", "mcp-test-server.ts");

describe("MCP client surface", () => {
  it(
    "A lists a server's declared tools; B calls one and returns its result; isError throws",
    async () => {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["mcp-tools", "--json", "--", tsxBin, serverScript], {
        stdout,
        stderr,
      });
      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");

      const tools = JSON.parse(stdout.text()) as Array<{
        name: string;
        description?: string;
        inputSchema: unknown;
      }>;
      expect(tools.map((tool) => tool.name).sort()).toEqual(["add", "always_fails"]);
      const addTool = tools.find((tool) => tool.name === "add");
      expect(addTool?.description).toBe("Adds two numbers");
      expect(addTool?.inputSchema).toBeTruthy();

      const client = await connectMcpServer({ command: tsxBin, args: [serverScript] });
      try {
        const result = await callMcpTool(client, "add", { a: 2, b: 3 });
        const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
        expect(content?.[0]?.text).toBe("5");

        await expect(callMcpTool(client, "always_fails", {})).rejects.toThrow(
          /deliberate failure/,
        );
      } finally {
        await client.close();
      }
    },
    30_000,
  );

  it(
    "forwards a caller's ClientOptions straight to Client's own constructor",
    async () => {
      // A pinned `versionNegotiation` mode has no fallback (connect.ts's
      // own header): it fails loudly unless the server offers that exact
      // revision via `server/discover`. This test server never implements
      // `server/discover`, so passing the pin here can only reject.
      // Dropping this argument at the call site instead of forwarding it
      // to `Client`'s own constructor would make this connect succeed
      // instead, the same as the plain connect above; that difference is
      // what proves the argument actually reaches `Client`.
      await expect(
        connectMcpServer(
          { command: tsxBin, args: [serverScript] },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        ),
      ).rejects.toThrow(/did not offer pinned protocol version/);
    },
    30_000,
  );

  it("refuses when no command follows --", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["mcp-tools"], { stdout, stderr });
    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("needs the server's own command after --");
  });
});

describe("`nuka steps --json` and the mcpClient fixture", () => {
  it("lists real vocabulary, never the MCP tool name, and reports needs_browser: false for the step that reaches it", async () => {
    const rootDir = fixture("mcp-tools-project");
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as {
      steps: Array<{ name: string; needs_browser?: boolean }>;
    };
    // Not empty: this fixture's own step (calls-mcp-tool-step.ts) makes
    // sure this assertion is actually exercising something.
    expect(report.steps.length).toBeGreaterThan(0);
    // The MCP server's own tool name is never part of this vocabulary —
    // the same separation `nuka steps` already keeps from a WebMCP page's
    // own declared tools.
    expect(report.steps.map((step) => step.name)).not.toContain("add");

    const step = report.steps.find((entry) => entry.name === "calls-mcp-tool-step");
    expect(step).toBeDefined();
    // Destructures mcpClient, never page or context: no browser need to
    // report.
    expect(step?.needs_browser).toBe(false);
  });
});

describe("formatSdkMissingMessage", () => {
  it("recognizes ERR_MODULE_NOT_FOUND naming the client package's own specifier", () => {
    const error = Object.assign(
      new Error("Cannot find package '@modelcontextprotocol/client' imported from /x/y.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const message = formatSdkMissingMessage(error);
    expect(message).toContain("@modelcontextprotocol/client@2.0.0");
    expect(message).toContain("npm install");
  });

  it("returns null for an ERR_MODULE_NOT_FOUND naming an unrelated package", () => {
    const error = Object.assign(
      new Error("Cannot find package 'left-pad' imported from /x/y.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(formatSdkMissingMessage(error)).toBeNull();
  });

  it("returns null for a value that isn't an Error at all", () => {
    expect(formatSdkMissingMessage("boom")).toBeNull();
  });
});
