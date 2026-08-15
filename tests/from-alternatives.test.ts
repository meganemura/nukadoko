import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `from`'s multiple-candidate form end to end (m7a-from-
// alternatives task spec; docs/spec.md "Chaining steps"' "A key may name
// more than one possible producer" paragraph and the three that follow) —
// against tests/fixtures/from-alternatives-project, where `archive-
// project.ts`'s own `projectId` may come from either `create-project.ts` or
// `import-project.ts`. Covers what m6a/m6b's own single-candidate tests
// (tests/from-chain.test.ts, tests/check-from-order.test.ts, tests/do-
// use.test.ts) do not: injection from either candidate without rewriting the
// consumer, `nuka check`/`nuka run` refusing a scenario that binds both
// candidates (required or optional alike — no priority), `nuka do --use`
// matching either candidate and refusing two `--use` values that resolve to
// different candidates for the same key, `nuka steps --json` exposing more
// than one candidate, and the structural check naming a broken candidate
// without silencing a sound one listed alongside it.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("from: injection picks whichever candidate actually ran", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-alternatives-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fills projectId from create-project when only that candidate is bound earlier", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const createRecordId = record.steps[0].record as string;
    const archiveStepRecord = await readStepRecord(rootDir, record.steps[1].record as string);
    expect(archiveStepRecord.status).toBe("ok");
    expect(archiveStepRecord.args).toEqual({ projectId: "p_acme" });
    expect(archiveStepRecord.used).toEqual([{ record: createRecordId, step: "create-project" }]);
  });

  it("fills projectId from import-project, the exact same consumer step, when only that candidate is bound earlier", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:7"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const importRecordId = record.steps[0].record as string;
    const archiveStepRecord = await readStepRecord(rootDir, record.steps[1].record as string);
    expect(archiveStepRecord.status).toBe("ok");
    // import-project's own returns key is "projectId", not "id" — proving
    // the injected value came from the *other* candidate's own key name.
    expect(archiveStepRecord.args).toEqual({ projectId: "p_beta" });
    expect(archiveStepRecord.used).toEqual([{ record: importRecordId, step: "import-project" }]);
  });
});

describe("nuka check: two or more candidates bound earlier is always an error", () => {
  async function checkReport(rootDir: string) {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
    return { exitCode, report: JSON.parse(stdout.text()) as { errors: FromOrderIssue[]; warnings: unknown[] } };
  }

  interface FromOrderIssue {
    readonly code: string;
    readonly message: string;
    readonly file?: string;
    readonly line?: number;
    readonly step?: string;
  }

  it("errors when both candidates are bound before a required-key consumer", async () => {
    const { report } = await checkReport(fixture("from-alternatives-project"));
    const issues = report.errors.filter((issue) => issue.code === "from-order-violation" && issue.line === 11);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("archive-project");
    expect(issues[0]!.message).toContain("create-project");
    expect(issues[0]!.message).toContain("import-project");
  });

  it("errors the same way when both candidates are bound before an optional-key consumer", async () => {
    const { report } = await checkReport(fixture("from-alternatives-project"));
    const issues = report.errors.filter((issue) => issue.code === "from-order-violation" && issue.line === 22);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("create-project");
    expect(issues[0]!.message).toContain("import-project");
  });

  it("errors when neither candidate is bound before a required-key consumer", async () => {
    const { report } = await checkReport(fixture("from-alternatives-project"));
    const issues = report.errors.filter((issue) => issue.code === "from-order-violation" && issue.line === 16);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("create-project");
    expect(issues[0]!.message).toContain("import-project");
  });

  it("says nothing when neither candidate is bound before an optional-key consumer", async () => {
    const { report } = await checkReport(fixture("from-alternatives-project"));
    const issues = report.errors.filter((issue) => issue.code === "from-order-violation" && issue.line === 19);
    expect(issues).toHaveLength(0);
  });

  it("says nothing when exactly one candidate is bound earlier (either one)", async () => {
    const { report } = await checkReport(fixture("from-alternatives-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "from-order-violation" && (issue.line === 3 || issue.line === 7),
    );
    expect(issues).toHaveLength(0);
  });
});

describe("nuka run: fails a scenario with two bound candidates before any step runs", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-alternatives-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses the whole scenario, no step records, no browser session ever opened", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/chain.feature:11"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    // Every step in this pickle is either the failing line or skipped —
    // none of them ever ran, so none has a step record.
    for (const step of record.steps) {
      expect(step.record).toBeNull();
    }
    const archiveStep = record.steps.find((s: { text: string }) => s.text === "the project is archived");
    expect(archiveStep.status).toBe("failed");
    expect(archiveStep.error.message).toContain("create-project");
    expect(archiveStep.error.message).toContain("import-project");
  });
});

describe("nuka do --use: either candidate fills the key", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-alternatives-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("--use a create-project step record fills projectId via that candidate", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createStepRecord = JSON.parse(createStdout.text());

    const archiveStdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", createStepRecord.record_id],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const archiveStepRecord = JSON.parse(archiveStdout.text());
    expect(archiveStepRecord.args).toEqual({ projectId: "p_acme" });
    expect(archiveStepRecord.used).toEqual([{ record: createStepRecord.record_id, step: "create-project" }]);
  });

  it("--use an import-project step record fills projectId via the other candidate", async () => {
    const importStdout = createCaptureSink();
    await runCli(["do", "import-project", "--args", '{"name":"beta"}'], {
      rootDir,
      stdout: importStdout,
      stderr: createCaptureSink(),
    });
    const importStepRecord = JSON.parse(importStdout.text());

    const archiveStdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", importStepRecord.record_id],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const archiveStepRecord = JSON.parse(archiveStdout.text());
    expect(archiveStepRecord.args).toEqual({ projectId: "p_beta" });
    expect(archiveStepRecord.used).toEqual([{ record: importStepRecord.record_id, step: "import-project" }]);
  });

  it("two --use values resolving the same key to different candidates fail setup", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createStepRecord = JSON.parse(createStdout.text());

    const importStdout = createCaptureSink();
    await runCli(["do", "import-project", "--args", '{"name":"beta"}'], {
      rootDir,
      stdout: importStdout,
      stderr: createCaptureSink(),
    });
    const importStepRecord = JSON.parse(importStdout.text());

    const archiveStdout = createCaptureSink();
    const archiveStderr = createCaptureSink();
    const exitCode = await runCli(
      [
        "do",
        "archive-project",
        "--args",
        "{}",
        "--use",
        createStepRecord.record_id,
        "--use",
        importStepRecord.record_id,
      ],
      { rootDir, stdout: archiveStdout, stderr: archiveStderr },
    );

    expect(exitCode).toBe(1);
    // Setup-phase fatal: no step record is ever printed to stdout.
    expect(archiveStdout.text()).toBe("");
    expect(archiveStderr.text()).toContain("projectId");
    expect(archiveStderr.text()).toContain("create-project");
    expect(archiveStderr.text()).toContain("import-project");
  });
});

describe("nuka steps --json: more than one candidate is exposed as an array", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("from-alternatives-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("shows from.projectId as an array of { step, key } candidates", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as {
      steps: Array<{ name: string; from?: Record<string, unknown> }>;
    };
    const archive = report.steps.find((s) => s.name === "archive-project");
    expect(Array.isArray(archive?.from?.projectId)).toBe(true);
    expect(archive?.from?.projectId).toEqual([
      { step: "create-project", key: "id" },
      { step: "import-project", key: "projectId" },
    ]);
  });

  it("nuka describe shows both candidates in one 'either of' string", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["describe", "archive-project"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const contract = JSON.parse(stdout.text());
    expect(contract.from.projectId).toContain("create-project.id");
    expect(contract.from.projectId).toContain("import-project.projectId");
    expect(contract.from.projectId).toContain("either of");
  });
});

describe("nuka check: a broken candidate is reported without silencing a sound one alongside it", () => {
  it("reports the unregistered candidate by name", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("from-alternatives-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; step?: string; message: string }>;
    };
    const issues = report.errors.filter(
      (issue) => issue.code === "from-structural-violation" && issue.step === "close-project-one-unregistered-candidate",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("never registered");
  });
});
