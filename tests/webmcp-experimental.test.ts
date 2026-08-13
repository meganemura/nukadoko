import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { experimental_callWebmcpTool } from "../src/webmcp/call-tool.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: the one test this experimental surface's own acceptance
// criteria ask for: A (`nuka experimental webmcp-tools`) lists a tool a
// page declared, and B (`experimental_callWebmcpTool`) calls that same tool
// and gets back its result, both against a real Chromium launched with the
// flag WebMCP needs (`--enable-features=WebMCPTesting`), plus a second
// test confirming `nuka steps` never lists that same tool, the mechanical
// guarantee behind this surface staying a separate face from the normal
// step vocabulary.
//
// Gated on chromium being installed at all (same top-level-await pattern as
// browser-evidence.test.ts), never on navigator.modelContext being present
// under the flag: that second condition failing is exactly the fact this
// experimental surface exists to surface, not something to skip past.

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = await isChromiumAvailable();

const TOOL_NAME = "add_numbers";

const TOOL_PAGE_HTML = `<!doctype html>
<html>
<head><title>webmcp tool page</title></head>
<body>
<script>
  if (navigator.modelContext) {
    navigator.modelContext.registerTool({
      name: ${JSON.stringify(TOOL_NAME)},
      description: "Adds two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"]
      },
      async execute({ a, b }) {
        return { content: [{ type: "text", text: String(a + b) }] };
      }
    });
  }
</script>
</body>
</html>`;

function startToolServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(TOOL_PAGE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

describe("WebMCP experimental surface", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startToolServer());
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(!chromiumAvailable)(
    "A lists a page's declared tool; B calls it and returns its result",
    async () => {
      const rootDir = fixture("webmcp-tools-project");

      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["experimental", "webmcp-tools", url, "--json"], {
        rootDir,
        stdout,
        stderr,
      });
      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");

      const tools = JSON.parse(stdout.text()) as Array<{
        name: string;
        description: string;
        inputSchema: unknown;
      }>;
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe(TOOL_NAME);
      expect(tools[0]!.description).toBe("Adds two numbers");
      // Carried through unmodified: Chromium hands inputSchema back as a
      // JSON string, not a parsed object (list-tools.ts's own doc comment).
      expect(typeof tools[0]!.inputSchema).toBe("string");
      expect(JSON.parse(tools[0]!.inputSchema as string)).toEqual({
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      });

      const browser = await chromium.launch({ args: ["--enable-features=WebMCPTesting"] });
      try {
        const page = await browser.newPage();
        await page.goto(url);
        const result = await experimental_callWebmcpTool(page, TOOL_NAME, { a: 2, b: 3 });
        expect(result).toEqual({ content: [{ type: "text", text: "5" }] });
      } finally {
        await browser.close();
      }
    },
  );

  it("`nuka steps` never lists a WebMCP tool a page declares", async () => {
    const rootDir = fixture("webmcp-tools-project");
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as { steps: Array<{ name: string }> };
    // Not empty: this fixture's own step (own-step.ts) makes sure this
    // assertion is actually exercising something, rather than passing
    // because there was nothing in the list to begin with.
    expect(report.steps.length).toBeGreaterThan(0);
    expect(report.steps.map((step) => step.name)).not.toContain(TOOL_NAME);
  });

  it("refuses a relative URL before launching a browser at all", async () => {
    const rootDir = fixture("webmcp-tools-project");
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["experimental", "webmcp-tools", "/tools"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("must be absolute");
    expect(stderr.text()).toContain("/tools");
    expect(stderr.text()).toContain("baseURL");
  });

  it.skipIf(!chromiumAvailable)(
    "B throws a dedicated error, naming the missing launch flag, when navigator.modelContext is absent",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await expect(experimental_callWebmcpTool(page, TOOL_NAME, {})).rejects.toThrow(
          /navigator\.modelContext is not present.*--enable-features=WebMCPTesting.*firefox and webkit/s,
        );
      } finally {
        await browser.close();
      }
    },
  );
});
