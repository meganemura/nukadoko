import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { callMcpTool } from "../src/mcp/call-tool.js";
import { connectMcpServer } from "../src/mcp/connect.js";
import { createCaptureSink, fixture, testsDir } from "./helpers/fixtures.js";

// Responsibility: this surface's own acceptance criteria, in one file. A
// real MCP server (tests/helpers/mcp-test-server.ts) spawned over stdio,
// connectMcpServer/callMcpTool ("nukadoko/mcp") calling a tool and reading
// back its result, plus `callMcpTool`'s own `isError` check throwing on a
// tool that reports an in-band failure, plus `connectMcpServer`'s own
// second, optional `ClientOptions` argument reaching `Client`'s own
// constructor rather than being silently dropped (a pinned
// `versionNegotiation` mode rejects against this server, which never
// implements `server/discover`; the same connect without that argument
// succeeds, which is what makes the rejection proof the argument
// arrived). A failed handshake must stop the process it spawned: the
// caller never receives a client to close, and a server that stays up
// after refusing `initialize` is still running when connect rejects.
// A successful handshake still leaves that process running until the
// caller closes the client. A second describe block confirms `nuka steps --json` never
// lists an MCP tool as vocabulary and reports `needs_browser: false` for
// the one step here that reaches the server exclusively through a
// fixture.

const serverScript = path.join(testsDir, "helpers", "mcp-test-server.ts");
const refusedScript = path.join(testsDir, "helpers", "mcp-handshake-refused.js");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("MCP client surface", () => {
  it(
    "calls a tool and returns its result; isError throws",
    async () => {
      const client = await connectMcpServer({ command: process.execPath, args: [serverScript] });
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
          { command: process.execPath, args: [serverScript] },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        ),
      ).rejects.toThrow(/did not offer pinned protocol version/);
    },
    30_000,
  );

  it("stops the spawned server when the handshake fails, and names the command", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nukadoko-mcp-handshake-"));
    const pidFile = path.join(dir, "pid");
    let pid = 0;
    try {
      let caught: unknown;
      try {
        await connectMcpServer({
          command: process.execPath,
          args: [refusedScript],
          env: { NUKA_PID_FILE: pidFile },
        });
      } catch (error) {
        caught = error;
      }
      pid = Number(readFileSync(pidFile, "utf8"));
      expect(caught).toBeInstanceOf(Error);
      // Checked before the message: on a build that does not stop the
      // child, this is the failure, and it is immediate. Waiting would
      // let the client package's own unref'd close timer kill the
      // process and hide the leak.
      expect(isAlive(pid)).toBe(false);
      expect((caught as Error).message).toContain(process.execPath);
    } finally {
      if (pid !== 0 && isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the server running after a successful handshake until the caller closes it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nukadoko-mcp-handshake-"));
    const pidFile = path.join(dir, "pid");
    let pid = 0;
    let client: Awaited<ReturnType<typeof connectMcpServer>> | undefined;
    try {
      client = await connectMcpServer({
        command: process.execPath,
        args: [serverScript],
        env: { NUKA_PID_FILE: pidFile },
      });
      pid = Number(readFileSync(pidFile, "utf8"));
      expect(isAlive(pid)).toBe(true);
      await client.close();
      client = undefined;
      expect(isAlive(pid)).toBe(false);
    } finally {
      if (client !== undefined) {
        await client.close().catch(() => {});
      }
      if (pid !== 0 && isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("`nuka steps --json` and the mcpClient fixture", () => {
  it("lists real vocabulary, never the MCP tool name, and reports needs_browser: false for the step that reaches it", async () => {
    const rootDir = fixture("mcp-client-project");
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
    // The MCP server's own tool name is never part of this vocabulary.
    expect(report.steps.map((step) => step.name)).not.toContain("add");

    const step = report.steps.find((entry) => entry.name === "calls-mcp-tool-step");
    expect(step).toBeDefined();
    // Destructures mcpClient, never page or context: no browser need to
    // report.
    expect(step?.needs_browser).toBe(false);
  });
});
