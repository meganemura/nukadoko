import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeBaseProject, type BaseProject } from "./helpers/base-project.js";
import { removeTempDir } from "./helpers/fixtures.js";

// Responsibility: judgments through the real commands (docs/spec.md
// "Judgments"): `nuka run` reads a judged-as claim's value and leaves the
// criterion pending, `nuka judge` shows it and records a judgment, the
// next run holds it judged, a changed value makes it stale, a value judged
// as missing fails, a value judged before is found again when it comes
// back, a step record edited after the run is refused, a value no channel
// holds is uncitable, and under `--base` a new criterion that only asks
// for a judgment is held on what the machine compared, never unproven,
// with the changed judgment file named. The value is a process's output,
// which the step record holds, so it is measured.

const GREET = `import { readFileSync } from "node:fs";
process.stdout.write(readFileSync(new URL("./greeting.txt", import.meta.url), "utf8"));
`;

const RUN_GREET = `import { z } from "zod";
import { defineStep, runCommand } from "nukadoko";
import { fileURLToPath } from "node:url";

export default defineStep({
  pattern: "I ask for the greeting",
  description: "Runs the greeting program",
  args: z.object({}),
  returns: z.object({ stdout: z.string(), exitCode: z.number().nullable(), stderr: z.string() }),
  mutates: false,
  async run() {
    return await runCommand(process.execPath, [fileURLToPath(new URL("../../lib/greet.mjs", import.meta.url))]);
  },
});
`;

const READS_AS = `import { z } from "zod";
import { defineStep } from "nukadoko";
import runGreet from "./run-greet.ts";

export default defineStep({
  pattern: "the greeting reads as {quality:string}",
  args: z.object({ quality: z.string(), stdout: runGreet.returns.shape.stdout }),
  from: { stdout: [runGreet, "stdout"] },
  claims: [{ actual: "stdout", view: "text", compare: "judged-as", expected: "quality" }],
});
`;

const TOTAL_READS_AS = `import { z } from "zod";
import { defineStep } from "nukadoko";
import aCart from "./a-cart.ts";

export default defineStep({
  pattern: "the total reads as {quality:string}",
  args: z.object({ quality: z.string(), total: z.number().int() }),
  from: { total: [aCart, "total"] },
  claims: [{ actual: "total", compare: "judged-as", expected: "quality" }],
});
`;

const GREETING = `Feature: Greeting

  Scenario: a first-time visitor is greeted
    When I ask for the greeting
    Then the greeting reads as "friendly to a first-time visitor"
`;

const WELCOME = "Welcome! Make yourself at home.\n";

interface Document {
  table: { rows: { line: number; verdict: string; cells: { world: string }[]; judgment?: { state: string; reason: string } }[]; judgments_changed?: string[] };
  findings: { code: string; message: string; severity?: string; file?: string; line?: number; fix?: string; do?: string }[];
  limits?: { kind: string; detail: string }[];
}

describe("judgments through nuka run and nuka judge", () => {
  let project: BaseProject & { readonly top: string };
  const run = async (...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string; document: Document; runId: string }> => {
    const result = await project.cli(["run", "--json", ...args]);
    const document = JSON.parse(result.stdout) as Document & { run_id: string };
    return { ...result, document, runId: document.run_id };
  };
  const findingLines = (stderr: string): string[] => stderr.split("\n").filter((line) => /^(failed|refused)\t/.test(line) || /^ {2}(fix|do): /.test(line));
  const judgmentFile = (): { judgments: { value: unknown; verdict: string; by: string }[] } =>
    JSON.parse(readFileSync(path.join(project.root, "judgments/features/greeting.feature.json"), "utf8"));

  beforeAll(async () => {
    project = await makeBaseProject();
    project.write({
      "lib/greet.mjs": GREET,
      "lib/greeting.txt": WELCOME,
      "features/steps/run-greet.ts": RUN_GREET,
      "features/steps/reads-as.ts": READS_AS,
      "features/steps/total-reads-as.ts": TOTAL_READS_AS,
      "features/greeting.feature": GREETING,
    });
  }, 60_000);

  afterAll(async () => {
    await removeTempDir(project.top);
  });

  it("leaves a value no judgment cites pending, shows it, records a judgment, and holds the next run on it", async () => {
    const first = await run("features/greeting.feature");
    expect(first.exitCode).toBe(1);
    const row = first.document.table.rows[0]!;
    expect([row.verdict, row.judgment?.state]).toEqual(["held", "pending"]);
    expect(first.document.findings.filter((finding) => finding.code.startsWith("judgment"))).toEqual([
      {
        severity: "failed",
        code: "judgment-pending",
        file: "features/greeting.feature",
        line: 3,
        message: 'Scenario "a first-time visitor is greeted" line 5 read "Welcome! Make yourself at home." for a judgment as "friendly to a first-time visitor", and no judgment cites it',
        fix: "a judge who did not write the change reads the value against the sentence, then records it with nuka judge and --meets or --misses, --by, and --because",
        do: `nuka judge features/greeting.feature:3 --run ${first.runId}`,
      },
    ]);

    const shown = await project.cli(["judge", "features/greeting.feature:3"]);
    expect(shown.exitCode).toBe(0);
    const lines = shown.stdout.split("\n");
    expect(lines.slice(0, 6)).toEqual([
      `features/greeting.feature:3 "a first-time visitor is greeted" in ${first.runId}: 1 value to judge`,
      '- line 5 "the greeting reads as "friendly to a first-time visitor"", claim 0, in default: pending',
      '  quality: "friendly to a first-time visitor"',
      expect.stringMatching(/^ {2}value, from:run-greet@4\.stdout as text, measured observed\.processes\[0\]\.stdout of step-/),
      "    Welcome! Make yourself at home.",
      expect.stringMatching(/^ {2}digest: sha256:[0-9a-f]{64}$/),
    ]);

    const recorded = await project.cli(["judge", "features/greeting.feature:3", "--meets", "--by", "reviewer", "--because", "It welcomes the visitor and asks nothing of them."]);
    expect(recorded.exitCode).toBe(0);
    expect(recorded.stderr).toBe(
      "wrote judgments/features/greeting.feature.json: commit it, so its review records who judged; the next run reads features/greeting.feature:3 against it\n  do: nuka run features/greeting.feature:3\n",
    );
    expect(judgmentFile().judgments.map((entry) => [entry.value, entry.verdict, entry.by])).toEqual([["Welcome! Make yourself at home.", "meets", "reviewer"]]);

    const second = await run("features/greeting.feature");
    expect(second.exitCode).toBe(0);
    expect(second.document.table.rows[0]!.judgment).toMatchObject({ state: "judged", reason: 'reviewer judged the value line 5 read as "friendly to a first-time visitor": It welcomes the visitor and asks nothing of them.' });
    expect(second.document.limits?.find((limit) => limit.kind === "judgment")?.detail).toBe("stands on a judgment by `reviewer`: nukadoko checked that the value is the one judged, not the judgment");
    const summary = readFileSync(path.join(project.root, ".nukadoko/runs", second.runId, "summary.md"), "utf8").split("\n");
    expect(summary.slice(1, 6)).toEqual([
      "# nukadoko run passed: 1 criterion, 1 held, 1 judgment judged",
      "",
      "| verdict | judgment | criterion | head default |",
      "| --- | --- | --- | --- |",
      "| held | judged | `features/greeting.feature:3` a first-time visitor is greeted | pass |",
    ]);
    expect(summary).toContain(
      '  - "Welcome! Make yourself at home." (from:run-greet@4.stdout as text) judged-as "friendly to a first-time visitor" (sentence:quality) for-judgment; measured: observed.processes[0].stdout of ' +
        summary.find((line) => line.includes("for-judgment"))!.split(" of ").at(-1),
    );
  }, 60_000);

  it("makes a changed value stale, fails a value judged as missing, finds an earlier judgment when its value comes back, and refuses an edited record", async () => {
    writeFileSync(path.join(project.root, "lib/greeting.txt"), "Provide credentials to continue.\n");
    const stale = await run("features/greeting.feature");
    expect(stale.exitCode).toBe(1);
    expect(stale.document.table.rows[0]!.judgment?.reason).toBe(
      'line 5 read "Provide credentials to continue.", and the judgment by reviewer in ' +
        `${(judgmentFile().judgments[0] as unknown as { run_id: string }).run_id} cited "Welcome! Make yourself at home.", so it does not cover what ran`,
    );
    expect(stale.document.findings.map((finding) => finding.code)).toContain("judgment-stale");

    // A step record edited after the run no longer has the digest run.json
    // recorded, so no judgment can cite it.
    const recordDir = path.join(project.root, ".nukadoko/runs", stale.runId, (stale.document as unknown as { table: { rows: { judgment: { reads: { record: string }[] } }[] } }).table.rows[0]!.judgment.reads[0]!.record);
    const record = JSON.parse(readFileSync(path.join(recordDir, "record.json"), "utf8")) as { claims: { actual: unknown }[] };
    const kept = JSON.stringify(record);
    record.claims[0]!.actual = "Welcome! Make yourself at home.";
    writeFileSync(path.join(recordDir, "record.json"), JSON.stringify(record));
    const forged = await project.cli(["judge", "features/greeting.feature:3", "--meets", "--by", "forger", "--because", "Fine."]);
    expect(forged.exitCode).toBe(2);
    expect(findingLines(forged.stderr)[0]).toMatch(/^refused\tjudgment-refused\t-\tsteps\/step-[^ ]+ holds a value whose digest is sha256:[0-9a-f]{64}, and run\.json recorded sha256:[0-9a-f]{64}, so the two records disagree$/);
    writeFileSync(path.join(recordDir, "record.json"), kept);

    expect((await project.cli(["judge", "features/greeting.feature:3", "--misses", "--by", "reviewer", "--because", "It asks for credentials before it welcomes anyone."])).exitCode).toBe(0);
    const misses = await run("features/greeting.feature");
    expect([misses.exitCode, misses.document.table.rows[0]!.verdict, misses.document.table.rows[0]!.judgment?.state]).toEqual([1, "held", "misses"]);

    writeFileSync(path.join(project.root, "lib/greeting.txt"), WELCOME);
    const back = await run("features/greeting.feature");
    expect([back.exitCode, back.document.table.rows[0]!.judgment?.state]).toEqual([0, "judged"]);
    expect(judgmentFile().judgments.map((entry) => entry.verdict).sort()).toEqual(["meets", "misses"]);
  }, 60_000);

  it("refuses a judgment with both verdicts, or without a name and a reason", async () => {
    const both = await project.cli(["judge", "features/greeting.feature:3", "--meets", "--misses", "--by", "a", "--because", "b"]);
    expect([both.exitCode, findingLines(both.stderr)[0]]).toEqual([2, "refused\tjudgment-refused\t-\t--meets and --misses say opposite things: give one"]);
    const unnamed = await project.cli(["judge", "features/greeting.feature:3", "--meets"]);
    expect(findingLines(unnamed.stderr)[0]).toBe("refused\tjudgment-refused\t-\ta judgment needs --by, the judge's name, and --because, why the value meets or misses the sentence, in one sentence");
  }, 60_000);

  it("reads a value step code computed as uncitable, and refuses to judge it", async () => {
    project.write({ "features/total.feature": 'Feature: Total\n\n  Scenario: the total reads well\n    Given a cart with 3 items\n    Then the total reads as "a round number"\n' });
    const result = await run("features/total.feature");
    expect(result.exitCode).toBe(1);
    expect(result.document.table.rows[0]!.judgment).toMatchObject({
      state: "uncitable",
      reason: "line 5 asks for a judgment of from:a-cart@4.total, which no channel of a step record holds, so no judgment can cite it",
    });
    const refused = await project.cli(["judge", "features/total.feature:3", "--meets", "--by", "a", "--because", "b"]);
    expect(findingLines(refused.stderr)[0]).toBe("refused\tjudgment-refused\t-\tline 5 read from:a-cart@4.total, which no channel of a step record holds, so a judgment cannot cite it");
    project.write({ "features/total.feature": "Feature: Total\n" });
  }, 60_000);

  it("under --base holds a new criterion that only asks for a judgment on what the machine compared, and names the changed judgment file", async () => {
    const base = project.commit("judged greeting");
    project.write({ "features/greeting.feature": `${GREETING}\n  Scenario: the greeting reads at a glance\n    When I ask for the greeting\n    Then the greeting reads as "short enough to read at a glance"\n` });
    project.commit("a criterion a reader judges");
    const pending = await run("--base", base);
    const row = pending.document.table.rows.find((entry) => entry.line === 7)!;
    expect([row.verdict, row.judgment?.state, row.cells.map((cell) => cell.world)]).toEqual(["held", "pending", ["head"]]);
    expect(pending.exitCode).toBe(1);

    expect((await project.cli(["judge", "features/greeting.feature:7", "--meets", "--by", "reviewer", "--because", "Five words a visitor takes in at once."])).exitCode).toBe(0);
    const judged = await run("--base", base);
    expect(judged.exitCode).toBe(0);
    expect(judged.document.table.judgments_changed).toEqual(["judgments/features/greeting.feature.json"]);
    const summary = readFileSync(path.join(project.root, ".nukadoko/runs", judged.runId, "summary.md"), "utf8");
    expect(summary).toContain("A judgment file changed since the base: `judgments/features/greeting.feature.json`.");
  }, 120_000);
});
