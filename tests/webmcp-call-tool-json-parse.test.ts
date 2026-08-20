import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_callWebmcpTool } from "../src/webmcp/call-tool.js";

// Responsibility: the one branch of experimental_callWebmcpTool (webmcp/
// call-tool.ts) that runs in Node rather than inside the page's own
// evaluate() callback: the JSON.parse of executeTool's own resolved
// string, and the dedicated error it throws when that string is not valid
// JSON. Every statement inside the evaluate() callback itself (the lookup,
// the "no such tool" throw, the executeTool call) runs in the browser
// process, not this one, so no amount of testing moves those lines: v8
// coverage instrumented in this Node process cannot observe code that ran
// in a separate Chromium process (measured directly against this same
// gap in tests/webmcp-experimental.test.ts's own coverage, list-tools.ts's
// readDeclaredWebmcpTools).
//
// Never needs Chromium's own --enable-features=WebMCPTesting flag, or a
// real WebMCP tool registration: experimental_callWebmcpTool only ever
// reads whatever `navigator.modelContext` the page happens to expose
// (errors.ts's own assertWebmcpAvailable check is `typeof ... !==
// "undefined"`), so a page script that defines a plain, fake
// modelContext satisfies it exactly as well as the real Chromium API does.
// A browser is still required to run that page script at all, so this test
// stays skipIf(!chromiumAvailable) the same as webmcp-experimental.test.ts's
// own tests; what the fake removes is only the flag and the registration.

const TOOL_PAGE_HTML = `<!doctype html>
<html>
<head><title>fake webmcp modelContext</title></head>
<body>
<script>
  navigator.modelContext = {
    async getTools() {
      return [{ name: "broken-tool", description: "returns unparseable JSON", inputSchema: {} }];
    },
    async executeTool(tool, argsJson) {
      return "not valid json{";
    }
  };
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

describe("experimental_callWebmcpTool: a tool result that is not valid JSON", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startToolServer());
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(!chromiumAvailable)(
    "throws a dedicated error naming the tool and the unparseable text",
    async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await expect(experimental_callWebmcpTool(page, "broken-tool", {})).rejects.toThrow(
          /WebMCP tool "broken-tool" returned a value that could not be parsed as JSON: not valid json\{/,
        );
      } finally {
        await browser.close();
      }
    },
  );
});
