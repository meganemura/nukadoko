import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, repoRoot, sourceNodeArgs } from "./helpers/fixtures.js";

// Responsibility: fixture lifetimes under `nuka explore`. A process-scope
// fixture lasts the whole invocation, runs and shrink attempts included,
// and a scenario-scope fixture lasts one sequence. SIGINT tears both down,
// as it does for `nuka do`. The signal case spawns a real process, for the
// reason tests/run-fixture-signal-teardown.test.ts gives.

interface LogEntry {
  readonly fixture: string;
  readonly phase: string;
  readonly outcome?: string;
}

const children: ChildProcess[] = [];

function model(step: string): string {
  return [
    'import { defineModel, modelCommand } from "../nukadoko-shim.js";',
    `import step from "./steps/${step}.js";`,
    "",
    "export default defineModel(() => 0).commands({",
    `  "${step}": modelCommand(step)({`,
    "    args: () => ({}),",
    "    pre: () => true,",
    "    next: (state) => state + 1,",
    "    post: (state) => state < 2,",
    "  }),",
    "});",
    "",
  ].join("\n");
}

async function readLog(rootDir: string): Promise<LogEntry[]> {
  try {
    const text = await readFile(path.join(rootDir, "fixture-log.jsonl"), "utf8");
    return text
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function count(log: readonly LogEntry[], fixture: string, phase: string): number {
  return log.filter((entry) => entry.fixture === fixture && entry.phase === phase).length;
}

describe("fixture scope under nuka explore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("signal-teardown-project");
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    children.length = 0;
    await removeTempDir(rootDir);
  });

  it("sets a process fixture up once across runs and shrink attempts, and a scenario fixture once per sequence", async () => {
    await writeFile(path.join(rootDir, "features", "finish-model.ts"), model("finish-fixture"));
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["explore", "features/finish-model.ts", "--seed", "1", "--runs", "3", "--length", "5"],
      { rootDir, stdout, stderr },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text().split("\n")[1]).toBe("# Run 1 of 3 failed after 3 steps. Shrunk to 3 steps in 5 attempts.");
    const log = await readLog(rootDir);
    expect({
      ledgerSetups: count(log, "ledger", "setup"),
      ledgerTeardowns: log.filter((entry) => entry.fixture === "ledger" && entry.phase === "teardown"),
      tenantSetups: count(log, "tenant", "setup"),
      tenantTeardowns: count(log, "tenant", "teardown"),
    }).toEqual({
      ledgerSetups: 1,
      ledgerTeardowns: [{ fixture: "ledger", phase: "teardown", outcome: "failed" }],
      tenantSetups: 6,
      tenantTeardowns: 6,
    });
    expect(log.at(-1)).toEqual({ fixture: "ledger", phase: "teardown", outcome: "failed" });
  });

  it("tears both scopes down when nuka explore receives SIGINT", async () => {
    await writeFile(path.join(rootDir, "features", "hold-model.ts"), model("hold-fixture"));
    const child = spawn(
      process.execPath,
      [
        ...sourceNodeArgs,
        path.join(repoRoot, "src", "cli.ts"),
        "explore",
        "features/hold-model.ts",
        "--seed",
        "1",
      ],
      { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    const deadline = Date.now() + 20_000;
    while (count(await readLog(rootDir), "ledger", "setup") === 0 || count(await readLog(rootDir), "tenant", "setup") === 0) {
      if (Date.now() > deadline) throw new Error(`fixture setup was not logged within 20s: ${JSON.stringify(await readLog(rootDir))}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    child.kill("SIGINT");
    const { code, signal } = await closed;

    expect(code === 128 + constants.signals.SIGINT || signal === "SIGINT").toBe(true);
    const teardowns = (await readLog(rootDir)).filter((entry) => entry.phase === "teardown");
    expect(teardowns).toEqual([
      { fixture: "tenant", phase: "teardown", outcome: "failed" },
      { fixture: "ledger", phase: "teardown", outcome: "failed" },
    ]);
  });
});
