import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testsDir } from "./helpers/fixtures.js";

// Agents run `npm test` at once in sibling git worktrees of this repository.
// The fixture helper has to keep every path it writes inside the checkout it
// was loaded from, or one run removes or rewrites another run's fixtures.

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function makeCheckout(root: string): Promise<void> {
  await mkdir(path.join(root, "tests", "helpers"), { recursive: true });
  await cp(path.join(testsDir, "helpers", "fixtures.ts"), path.join(root, "tests", "helpers", "fixtures.ts"));
  await mkdir(path.join(root, "tests", "fixtures", "tiny"), { recursive: true });
  await writeFile(path.join(root, "tests", "fixtures", "tiny", "a.txt"), `${path.basename(root)}\n`);
}

/** Runs the checkout's own helper in its own process, as `npm test` there would. */
function runHelper(root: string): Promise<{ code: number | null; stdout: string }> {
  const helperUrl = pathToFileURL(path.join(root, "tests", "helpers", "fixtures.ts")).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const h = await import(${JSON.stringify(helperUrl)});
       const made = [];
       for (let i = 0; i < 20; i++) {
         await h.ensureNukadokoShim();
         const copy = await h.copyFixtureToTempDir("tiny");
         const empty = await h.createEmptyTempDir();
         made.push(copy, empty);
         if (i % 2 === 0) { await h.removeTempDir(copy); await h.removeTempDir(empty); }
       }
       process.stdout.write(JSON.stringify(made));`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout })));
}

describe("tests/helpers/fixtures.ts in two checkouts at once", () => {
  it("writes only under the checkout it was loaded from", async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "nukadoko-checkouts-")));
    const first = path.join(scratch, "wt-a");
    const second = path.join(scratch, "wt-b");
    await makeCheckout(first);
    await makeCheckout(second);

    const [a, b] = await Promise.all([runHelper(first), runHelper(second)]);
    expect([a.code, b.code]).toEqual([0, 0]);

    for (const [root, result] of [
      [first, a],
      [second, b],
    ] as const) {
      const tempRoot = path.join(root, "tests", ".tmp-fixtures");
      const made = JSON.parse(result.stdout) as string[];
      expect(made).toHaveLength(40);
      expect(made.filter((dir) => path.dirname(dir) !== tempRoot)).toEqual([]);

      const kept = made.filter((_, index) => Math.floor(index / 2) % 2 === 1);
      const entries = (await readdir(tempRoot)).sort();
      expect(entries).toEqual([...kept.map((dir) => path.basename(dir)), "node_modules", "package.json"].sort());
      for (const dir of kept.filter((d) => path.basename(d).startsWith("fixture-"))) {
        expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe(`${path.basename(root)}\n`);
      }

      const shim = path.join(tempRoot, "node_modules", "nukadoko");
      expect((await readdir(shim)).sort()).toEqual([
        "compat.d.ts",
        "compat.js",
        "index.d.ts",
        "index.js",
        "package.json",
      ]);
      expect(await readFile(path.join(shim, "index.js"), "utf8")).toBe('export * from "../../../../src/index.js";\n');
      expect(await readFile(path.join(shim, "compat.js"), "utf8")).toBe(
        'export * from "../../../../src/compat/index.js";\n',
      );
    }
    expect((await readdir(scratch)).sort()).toEqual(["wt-a", "wt-b"]);
  });
});
