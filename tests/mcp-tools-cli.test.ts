import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, repoRoot, testsDir } from "./helpers/fixtures.js";

// Responsibility: the two `nuka mcp-tools` outcomes tests/mcp-client.test.ts
// never exercises (its own header says it checks the JSON path, the
// missing-command refusal, and formatClientMissingMessage in isolation).
// This file covers the other two: the default (non-`--json`) text output,
// and a connect failure that is *not* the client package missing (a
// nonexistent server command), which must fall through to the underlying
// error's own message rather than the install hint.

const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const serverScript = path.join(testsDir, "helpers", "mcp-test-server.ts");

describe("nuka mcp-tools: CLI wiring", () => {
  it(
    "without --json: prints one name\\tdescription line per tool, no inputSchema",
    async () => {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["mcp-tools", "--", tsxBin, serverScript], { stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      const lines = stdout.text().trim().split("\n");
      expect(lines.sort()).toEqual(
        ["add\tAdds two numbers", "always_fails\tAlways returns an in-band tool failure"].sort(),
      );
      // The verbose inputSchema is `--json`-only (this command's own decision,
      // shared with `nuka steps`/webmcp-tools): a schema object would never
      // render as valid tab-separated text.
      expect(stdout.text()).not.toContain("{");
    },
    // Same 30s allowance tests/mcp-client.test.ts already gives this same
    // tsx-spawned server, rather than vitest's own 5s default.
    30_000,
  );

  it("a connect failure that is not the client package missing: reports the real error, not the install hint", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["mcp-tools", "--", "definitely-does-not-exist-nukadoko-mcp-tools-test"],
      { stdout, stderr },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    // A spawn failure for a command that does not exist on PATH has nothing
    // to do with the optional @modelcontextprotocol/client peer dependency,
    // which is installed in this repo either way, so the install hint must
    // never be shown for it.
    expect(stderr.text()).toContain("definitely-does-not-exist-nukadoko-mcp-tools-test");
    expect(stderr.text()).not.toContain("npm install");
  });
});
