import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transportsBuiltInConnect } from "../src/check/mcp-unmeasured.js";
import { runCli } from "../src/cli/run-cli.js";
import { bySeverity } from "./helpers/envelope.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the `mcp-transport-unmeasured` note of `nuka check`: a
// transport built inside a `connect` call is one nothing can wrap in
// measureMcp, and only that shape is named.

describe("transportsBuiltInConnect", () => {
  it("names a transport built inside connect, and nothing passed by name or in a comment", () => {
    expect(transportsBuiltInConnect("await client.connect(new StdioClientTransport({ command: 'x' }))")).toEqual(["StdioClientTransport"]);
    expect(transportsBuiltInConnect("await client.connect(measureMcp(new StreamableHTTPClientTransport(url)))")).toEqual([]);
    expect(transportsBuiltInConnect("const t = new StdioClientTransport(); await client.connect(t)")).toEqual([]);
    expect(transportsBuiltInConnect("// client.connect(new StdioClientTransport())\nconst s = 'client.connect(new SSEClientTransport(u))'")).toEqual([]);
  });
});

describe("nuka check on an MCP client connected to a bare transport", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("mcp-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("notes a transport built inside the connect call, which nothing can wrap", async () => {
    const config = path.join(rootDir, "nukadoko.config.ts");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "  fixtures: {",
        "  fixtures: {\n    bare: async ({}, use) => {\n      const client = new Client();\n      await client.connect(new LocalStdioClientTransport());\n      await use(client);\n    },",
      ) + "\nclass LocalStdioClientTransport {}\n",
    );
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
    const notes = (bySeverity(stdout.text()) as { notes: { code: string; fixture?: string; file?: string }[] }).notes;
    expect(notes.filter((note) => note.code === "mcp-transport-unmeasured")).toEqual([
      expect.objectContaining({ fixture: "bare", file: "nukadoko.config.ts" }),
    ]);
  });
});
