import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoApp } from "../examples/todo/app/server.js";
import { copyExampleToTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: anti-rot proof for examples/migration/README.md (m2e1-
// migration-example task spec, deliverable 4) -- the shipped, deliberately
// mid-migration suite (a mix of compat steps and one promoted producer/
// consumer pair) actually runs green end to end, and the record/receipt
// shapes the walkthrough quotes as real captured output stay true. Only
// that mechanical claim is asserted here; the walkthrough's own stage-by-
// stage narrative is prose a reader enacts by hand, not something this
// suite re-derives (same split as tests/examples-todo.test.ts).
//
// Run against the *built* `dist/cli.js` (via `node`, not `src/cli.ts`/
// `runCli` from src), for the same reason tests/compat-discover.test.ts's
// own "resolves nukadoko/compat via the real published package" test does:
// this temp copy is nested inside this very package's own directory tree,
// so Node's self-referencing package resolution sends this example's own
// bare `"nukadoko"`/`"nukadoko/compat"` imports straight to `./dist/...`,
// unconditionally, before any node_modules shim is even consulted. Compat's
// registration buffers (Given/When/Then/Before/defineWorld) are ordinary
// module-closure state, not a Symbol.for brand -- they do not survive a
// src/dist split the way a typed `defineStep` step does, so discovery must
// run from dist too, or this suite's compat steps and its one Before hook
// would silently vanish from the vocabulary discovery itself builds.
async function runNuka(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = path.join(repoRoot, "dist", "cli.js");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: execError.stdout ?? "", stderr: execError.stderr ?? "", exitCode: execError.code ?? 1 };
  }
}

function startTodoApp(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createTodoApp();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

// The committed config points at the fixed port the README tells a human
// reader to use (http://localhost:4000); this test needs an ephemeral one
// instead, same convention as tests/examples-todo.test.ts's own helper.
async function pointConfigAt(rootDir: string, baseURL: string): Promise<void> {
  await writeFile(
    path.join(rootDir, "nukadoko.config.ts"),
    [
      'import { defineConfig } from "nukadoko";',
      "",
      `export default defineConfig({ baseURL: "${baseURL}" });`,
      "",
    ].join("\n"),
  );
}

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("examples/migration", () => {
  let server: Server;
  let rootDir: string;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("runs the shipped mixed compat/typed suite green, with the shapes README.md quotes", async () => {
    const started = await startTodoApp();
    server = started.server;
    rootDir = await copyExampleToTempDir("migration");
    await pointConfigAt(rootDir, started.baseURL);

    const { stdout, stderr, exitCode } = await runNuka(["run", "features/migration.feature"], rootDir);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const records = stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.status).toBe("passed");
      for (const step of record.steps) {
        expect(step.status).toBe("passed");
      }
      // The one Before hook this suite keeps (features/steps/hooks.ts) ran
      // for every pickle, and reported ok -- no receipt of its own, per
      // docs/spec.md "Compat steps"/"Running".
      expect(record.hooks).toEqual([{ type: "before", status: "ok" }]);
    }

    // Scenario 1 (still-compat glue): the stash write, the table+hashes
    // seeding step, and the RegExp count assertion.
    const scenario1 = records[0];
    const stashWriteStep = scenario1.steps.find((s: { text: string }) => s.text.includes("is stashed"));
    const seedStep = scenario1.steps.find((s: { text: string }) =>
      s.text.startsWith("the following legacy todos"),
    );
    const countStep = scenario1.steps.find((s: { text: string }) => s.text.includes("todo list has"));
    const stashReadStep = scenario1.steps.find((s: { text: string }) => s.text.includes("reads"));

    // The undeclared World stash: measured (world.writes/reads) even though
    // no schema validates it.
    const stashWriteReceipt = await readReceipt(rootDir, stashWriteStep.receipt);
    expect(stashWriteReceipt.result).toBeNull();
    expect(stashWriteReceipt.world).toEqual({ reads: [], writes: ["note"] });
    const stashReadReceipt = await readReceipt(rootDir, stashReadStep.receipt);
    expect(stashReadReceipt.world).toEqual({ reads: ["note"], writes: [] });

    // The seeding step: both `observed` (2 POSTs) and `world` (the one
    // declared key, seededCount) show up on the same receipt -- the exact
    // claim README.md's "measured for free" section quotes.
    const seedReceipt = await readReceipt(rootDir, seedStep.receipt);
    expect(seedReceipt.result).toBeNull();
    expect(seedReceipt.observed).toEqual({ http_reads: 0, http_writes: 2 });
    expect(seedReceipt.world).toEqual({ reads: [], writes: ["seededCount"] });

    // The RegExp-pattern count assertion: read-only, no World touch.
    const countReceipt = await readReceipt(rootDir, countStep.receipt);
    expect(countReceipt.observed).toEqual({ http_reads: 1, http_writes: 0 });
    expect(countReceipt.world).toBeUndefined();

    // Scenario 2 (the promoted pair): the producer's validated result is
    // what the consumer reads back through ctx.resultOf.
    const scenario2 = records[1];
    const createStep = scenario2.steps[0];
    const resultOfStep = scenario2.steps[1];
    expect(createStep.text).toContain("is created");
    expect(resultOfStep.text).toContain("resultOf");

    const createReceipt = await readReceipt(rootDir, createStep.receipt);
    expect(createReceipt.result).toMatchObject({ title: "Read a book", done: false });
    expect(createReceipt.world).toBeUndefined();

    const resultOfReceipt = await readReceipt(rootDir, resultOfStep.receipt);
    expect(resultOfReceipt.used).toEqual([createStep.receipt]);
    expect(resultOfReceipt.result).toEqual({ id: (createReceipt.result as { id: string }).id });
    expect(resultOfReceipt.world).toBeUndefined();
  });
});
