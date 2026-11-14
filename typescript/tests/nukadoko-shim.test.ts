import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ensureNukadokoShim, testsDir } from "./helpers/fixtures.js";

// Every Vitest worker calls ensureNukadokoShim while other workers load the
// generated configs that import "nukadoko" through it, so a rewrite that
// briefly leaves the file empty fails some other test file's load.
describe("ensureNukadokoShim", () => {
  it("never shows a reader an empty shim while another process calls it again", async () => {
    await ensureNukadokoShim();
    const shimEntry = path.join(testsDir, ".tmp-fixtures", "node_modules", "nukadoko", "index.js");
    const expected = await readFile(shimEntry, "utf8");

    const helperUrl = pathToFileURL(path.join(testsDir, "helpers", "fixtures.ts")).href;
    const writer = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { ensureNukadokoShim } = await import(${JSON.stringify(helperUrl)});
         const end = Date.now() + 1500;
         while (Date.now() < end) await ensureNukadokoShim();`,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const exited = new Promise<number | null>((resolve) => writer.on("exit", resolve));

    const seen = new Set<string>();
    let running = true;
    void exited.then(() => {
      running = false;
    });
    while (running) {
      seen.add(await readFile(shimEntry, "utf8"));
    }

    expect(await exited).toBe(0);
    expect([...seen]).toEqual([expected]);
  }, 30_000);
});
