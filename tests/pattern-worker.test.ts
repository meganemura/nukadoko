import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: the worker thread that tests a `matches` claim never
// keeps its process alive (src/run/pattern-worker.ts). A `--concurrency`
// worker process ends when its event loop drains, so a referenced pattern
// worker held it open after its last scenario, with the parent waiting on
// it. The test runs the built module in a process of its own, the way a
// run worker loads it, and fails on the time limit when that process does
// not exit.

const execFileAsync = promisify(execFile);
const workerModule = pathToFileURL(path.join(repoRoot, "dist", "run", "pattern-worker.js")).href;

async function runScript(body: string): Promise<{ stdout: string; ms: number }> {
  const script = `import { testPatternInWorker } from ${JSON.stringify(workerModule)};\n${body}`;
  const started = Date.now();
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { timeout: 15_000 });
  return { stdout, ms: Date.now() - started };
}

describe("the pattern worker", () => {
  it("lets its process exit once a pattern was tested", async () => {
    const { stdout, ms } = await runScript(
      'console.log(JSON.stringify(await testPatternInWorker("^a+$", "aaa", 5000, "a test")));',
    );
    expect(JSON.parse(stdout)).toEqual({ holds: true, matchesEmpty: false });
    expect(ms).toBeLessThan(10_000);
  });

  it("lets its process exit after a worker stopped for a slow pattern was replaced", async () => {
    const { stdout, ms } = await runScript(
      [
        'const slow = await testPatternInWorker("^(a+)+$", "a".repeat(34) + "!", 50, "a test");',
        'const next = await testPatternInWorker("^b$", "b", 5000, "a test");',
        "console.log(JSON.stringify({ slow, next }));",
      ].join("\n"),
    );
    expect(JSON.parse(stdout)).toEqual({
      slow: { reason: "matches did not finish within 50ms (a test), so nukadoko stopped the pattern" },
      next: { holds: true, matchesEmpty: false },
    });
    expect(ms).toBeLessThan(10_000);
  });
});
