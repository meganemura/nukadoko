import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  fixture,
  removeTempDir,
  repoRoot,
} from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

describe("nuka steps", () => {
  it("lists the vocabulary as JSON: name, patterns, description, mutates", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    // Top-level `{ steps, import_failures }`, not a bare array
    // (fb5-loader-visibility task spec, decision 1) — `import_failures` is
    // always present, `[]` here since this fixture has nothing broken.
    const report = JSON.parse(stdout.text());
    expect(report.import_failures).toEqual([]);
    expect(report.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "create-project",
          patterns: ["a project {string} exists"],
          description: "Create a project and return its id",
          mutates: true,
        }),
        expect.objectContaining({
          name: "list-projects",
          patterns: [],
          mutates: false,
        }),
      ]),
    );
    expect(report.steps).toHaveLength(3);
  });

  it("never includes rationale, even for a step that declares one", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text());
    for (const summary of report.steps) {
      expect(summary).not.toHaveProperty("rationale");
    }
  });

  it("propagates a ConfigError as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("typo");
  });
});

describe("nuka describe", () => {
  it("prints args/returns as JSON Schema", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "create-project"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const contract = JSON.parse(stdout.text());
    expect(contract.name).toBe("create-project");
    expect(contract.mutates).toBe(true);
    expect(contract.args).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(contract.returns).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      required: expect.arrayContaining(["id", "name"]),
    });
  });

  it("includes rationale for a step that declares one", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "create-project"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const contract = JSON.parse(stdout.text());
    expect(contract.rationale).toBe("Fixture-only note: exercises describe's rationale field.");
  });

  it("omits rationale entirely (no empty field) for a step that declares none", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "list-projects"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const contract = JSON.parse(stdout.text());
    expect(contract).not.toHaveProperty("rationale");
  });

  it("exits 1 with a stderr message for an unknown step name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "no-such-step"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no-such-step");
  });
});

describe("nuka do", () => {
  it("executes a pure ok step and writes a step record", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["do", "echo", "--args", JSON.stringify({ value: "hi" })], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("ok");
      expect(stepRecord.step).toBe("echo");
      expect(stepRecord.kind).toBe("do");
      expect(stepRecord.args).toEqual({ value: "hi" });
      expect(stepRecord.result).toEqual({ value: "hi" });
      expect(stepRecord.environment).toBe("default");
      expect(stepRecord.session).toBeNull();
      expect(stepRecord.scenario).toBeNull();
      expect(stepRecord.evidence.dir).toBe(path.join(".nukadoko", "records", "steps", stepRecord.record_id));
      expect(stepRecord.evidence.screenshots).toEqual([]);
      expect(stepRecord.evidence.trace).toBeUndefined();
      expect(stepRecord.evidence.http).toBeUndefined();
      // No network call was ever made (this task's spec, decision 3):
      // `observed` is still always present on the step record, at zero.
      expect(stepRecord.observed).toEqual({ http_reads: 0, http_writes: 0 });
      // `echo` declares `mutates: false` explicitly: a typed step's step
      // record carries that declaration verbatim, never `null` (`null` is
      // reserved for a compat step, which has no declaration at all).
      expect(stepRecord.mutates).toBe(false);

      const recordPath = path.join(rootDir, stepRecord.evidence.dir, "record.json");
      expect(existsSync(recordPath)).toBe(true);
      const onDisk = JSON.parse(await readFile(recordPath, "utf8"));
      expect(onDisk).toEqual(stepRecord);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("--tag is gone: yargs reports it as an unknown argument (design decision 2026-08-02, --tag removed)", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stderr = createCaptureSink();
      await runCli(
        ["do", "echo", "--args", JSON.stringify({ value: "hi" }), "--tag", "issue-123"],
        { rootDir, stdout: createCaptureSink(), stderr },
      );

      expect(stderr.text()).toContain("tag");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("an unknown flag fails setup: exit 1, stderr names it, no step record written (yargs runs the matched handler after .fail() unless run-cli.ts guards it)", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "echo", "--args", JSON.stringify({ value: "hi" }), "--unknown-flag", "x"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain("unknown-flag");
      expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("writes a failed step record with exit 1 when args fail schema validation", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["do", "echo", "--args", "{}"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("failed");
      expect(stepRecord.result).toBeUndefined();
      expect(stepRecord.error.message).toBeTruthy();
      // args validation failure classifies as "args_invalid", distinct from
      // an ordinary step throw.
      expect(stepRecord.error.kind).toBe("args_invalid");
      expect(existsSync(path.join(rootDir, stepRecord.evidence.dir, "record.json"))).toBe(true);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("writes a failed step record with exit 1 when run throws", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["do", "throws", "--args", "{}"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("failed");
      expect(stepRecord.error.message).toBe("boom");
      // An ordinary step throw is the catch-all "step_error", distinct from
      // every contract-layer kind.
      expect(stepRecord.error.kind).toBe("step_error");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("writes a failed step record with exit 1 when the result fails its returns schema", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["do", "bad-returns", "--args", "{}"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("failed");
      expect(stepRecord.error.message).toContain("returns");
      // A returns-schema failure classifies as "result_invalid", distinct
      // from "args_invalid"/"step_error".
      expect(stepRecord.error.kind).toBe("result_invalid");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("does not create a step record directory for an unknown step", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stderr = createCaptureSink();
      const exitCode = await runCli(["do", "no-such-step", "--args", "{}"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stderr.text()).toContain("no-such-step");
      expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("does not create a step record directory for malformed --args JSON", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stderr = createCaptureSink();
      const exitCode = await runCli(["do", "echo", "--args", "{not json"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stderr.text()).not.toBe("");
      expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("executes create-project against basic-project end to end (acceptance scenario)", async () => {
    const rootDir = await copyFixtureToTempDir("basic-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "create-project", "--args", JSON.stringify({ name: "x" })],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("ok");
      expect(stepRecord.result).toEqual({ id: "p_0001", name: "x" });

      const recordPath = path.join(
        rootDir,
        ".nukadoko",
        "records",
        "steps",
        stepRecord.record_id,
        "record.json",
      );
      expect(existsSync(recordPath)).toBe(true);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("nuka (process)", () => {
  it("runs end-to-end via tsx against a fixture project", async () => {
    const cliPath = path.join(repoRoot, "src", "cli.ts");
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

    const { stdout, stderr } = await execFileAsync(tsxBin, [cliPath, "steps", "--json"], {
      cwd: fixture("basic-project"),
    });

    expect(stderr).toBe("");
    const report = JSON.parse(stdout);
    expect(report.steps.map((s: { name: string }) => s.name).sort()).toEqual([
      "create-project",
      "get-project",
      "list-projects",
    ]);
  });

  it("runs `do` end-to-end via tsx against a fixture project, record.json included", async () => {
    const cliPath = path.join(repoRoot, "src", "cli.ts");
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
    const rootDir = await copyFixtureToTempDir("basic-project");

    try {
      const { stdout, stderr } = await execFileAsync(
        tsxBin,
        [cliPath, "do", "create-project", "--args", '{"name":"x"}'],
        { cwd: rootDir },
      );

      expect(stderr).toBe("");
      const stepRecord = JSON.parse(stdout);
      expect(stepRecord.status).toBe("ok");
      expect(stepRecord.result).toEqual({ id: "p_0001", name: "x" });

      const recordPath = path.join(
        rootDir,
        ".nukadoko",
        "records",
        "steps",
        stepRecord.record_id,
        "record.json",
      );
      expect(existsSync(recordPath)).toBe(true);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
