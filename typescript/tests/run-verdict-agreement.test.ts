import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: when a control's proof runs agree, against a copy of
// tests/fixtures/run-verdict-project with one Then of two claims. Runs
// agree when they broke the same claim at the same Then line, whatever
// value each saw: two runs that broke two claims of the line are flaky
// and prove nothing, and two that broke one claim with two values prove
// the row, with each run's value on the cell.

// Where the banner is off, the step counts its readings in a file beside
// the project. `mode.json` says what each reading breaks: "claims" breaks
// the first claim on reading 1 and the second after it, and "values"
// breaks the second claim every time, with a count that differs per
// reading.
const STEP = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the banner reads {state:string} and its count reads 0",
  description: "Read BANNER and a count; where the banner is off, mode.json decides which claim breaks",
  args: z.object({ state: z.string() }),
  observe({ env }) {
    if (env.BANNER === "on") return { banner: "on", count: 0 };
    const root = new URL("../../", import.meta.url);
    const mode = JSON.parse(readFileSync(new URL("mode.json", root), "utf8"));
    mkdirSync(new URL(".counters/", root), { recursive: true });
    const file = new URL(".counters/readings", root);
    let n = 0;
    try { n = Number(readFileSync(file, "utf8")); } catch {}
    writeFileSync(file, String(n + 1));
    if (mode === "claims") return n === 0 ? { banner: "off", count: 0 } : { banner: "on", count: 503 };
    return { banner: "on", count: 500 + n };
  },
  claims: [
    { actual: "banner", compare: "equal", expected: "state" },
    { actual: "count", compare: "equal", expected: { literal: 0 } },
  ],
});
`;

const FEATURE = 'Feature: Two claims\n\n  @with:banner\n  Scenario: two claims\n    Then the banner reads "on" and its count reads 0\n';

async function run(mode: "claims" | "values") {
  const rootDir = await copyFixtureToTempDir("run-verdict-project");
  try {
    writeFileSync(path.join(rootDir, "features", "steps", "two-claims.ts"), STEP);
    writeFileSync(path.join(rootDir, "features", "two.feature"), FEATURE);
    writeFileSync(path.join(rootDir, "mode.json"), JSON.stringify(mode));
    const exitCode = await runCli(["run", "features/two.feature", "--proof-runs", "3"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() });
    const document = latestRunJson(rootDir) as { table: { rows: { verdict: string; reason: string; cells: Record<string, unknown>[] }[] } };
    return { exitCode, row: document.table.rows[0]! };
  } finally {
    await removeTempDir(rootDir);
  }
}

describe("nuka run: when a control's proof runs agree", () => {
  it("makes two runs that broke two claims of one Then line flaky, and the row held", async () => {
    const { exitCode, row } = await run("claims");
    expect(exitCode).toBe(0);
    expect(row.cells[0]).toMatchObject({ environment: "flag-off", role: "control", outcome: "flaky", line: 5, runs: 2 });
    expect(row.cells[0]).not.toHaveProperty("claim");
    expect(row.verdict).toBe("held");
  });

  it("makes runs that broke one claim with a different value each agree, prove the row, and keep each value", async () => {
    const { exitCode, row } = await run("values");
    expect(exitCode).toBe(0);
    expect(row.cells[0]).toMatchObject({
      environment: "flag-off",
      role: "control",
      outcome: "fail",
      line: 5,
      runs: 3,
      claim: 1,
      actuals: [{ value: 500 }, { value: 501 }, { value: 502 }],
    });
    expect(row.verdict).toBe("proven");
  });
});
