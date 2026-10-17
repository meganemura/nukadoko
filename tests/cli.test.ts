import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  createEmptyTempDir,
  fixture,
  removeTempDir,
  repoRoot,
  sourceNodeArgs,
  withoutNoConfigLine,
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
    expect(withoutNoConfigLine(stderr.text())).toBe("");
    // Top-level `{ steps, import_failures }`, not a bare array —
    // `import_failures` is
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

  it("never includes rationale, even for a step file that still passes one", async () => {
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
    expect(withoutNoConfigLine(stderr.text())).toBe("");
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

  it("omits a defaulted args key from required and keeps a key with no default", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "greet-with-default"], {
      rootDir: fixture("do-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(withoutNoConfigLine(stderr.text())).toBe("");
    const contract = JSON.parse(stdout.text());
    // greet-with-default's args are { name: string, tag: string default
    // "guest" }. `name` is what a caller must supply. `tag` is not: the
    // schema fills it, and `nuka do` already accepts the call without it.
    expect(contract.args.required).toContain("name");
    expect(contract.args.required).not.toContain("tag");
    expect(contract.args.additionalProperties).toBe(false);
  });

  it("omits rationale for a step file that still passes one", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "create-project"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    const contract = JSON.parse(stdout.text());
    expect(contract.description).toBe("Create a project and return its id");
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
      expect(withoutNoConfigLine(stderr.text())).toBe("");
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("passed");
      expect(stepRecord.step).toBe("echo");
      expect(stepRecord.kind).toBe("do");
      expect(stepRecord.args).toEqual({ value: "hi" });
      expect(stepRecord.result).toEqual({ value: "hi" });
      expect(stepRecord.environment).toBe("default");
      expect(stepRecord.session).toBeNull();
      expect(stepRecord.scenario_record_id).toBeNull();
      expect(stepRecord.evidence.dir).toBe(path.join(".nukadoko", "records", "steps", stepRecord.step_record_id));
      expect(stepRecord.evidence.screenshots).toEqual([]);
      expect(stepRecord.evidence.trace).toBeUndefined();
      expect(stepRecord.evidence.http).toBeUndefined();
      // No network call was ever made:
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
      expect(stepRecord.args).toEqual({ n: 3 });
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
      expect(withoutNoConfigLine(stderr.text())).toBe("");
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("passed");
      expect(stepRecord.result).toEqual({ id: "p_0001", name: "x" });

      const recordPath = path.join(
        rootDir,
        ".nukadoko",
        "records",
        "steps",
        stepRecord.step_record_id,
        "record.json",
      );
      expect(existsSync(recordPath)).toBe(true);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("nuka (process)", () => {
  it("runs end-to-end from source against a fixture project", async () => {
    const cliPath = path.join(repoRoot, "src", "cli.ts");

    const { stdout, stderr } = await execFileAsync(process.execPath, [...sourceNodeArgs, cliPath, "steps", "--json"], {
      cwd: fixture("basic-project"),
    });

    expect(withoutNoConfigLine(stderr)).toBe("");
    const report = JSON.parse(stdout);
    expect(report.steps.map((s: { name: string }) => s.name).sort()).toEqual([
      "create-project",
      "get-project",
      "list-projects",
    ]);
  });

  it("runs `do` end-to-end from source against a fixture project, record.json included", async () => {
    const cliPath = path.join(repoRoot, "src", "cli.ts");
    const rootDir = await copyFixtureToTempDir("basic-project");

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [...sourceNodeArgs, cliPath, "do", "create-project", "--args", '{"name":"x"}'],
        { cwd: rootDir },
      );

      expect(withoutNoConfigLine(stderr)).toBe("");
      const stepRecord = JSON.parse(stdout);
      expect(stepRecord.status).toBe("passed");
      expect(stepRecord.result).toEqual({ id: "p_0001", name: "x" });

      const recordPath = path.join(
        rootDir,
        ".nukadoko",
        "records",
        "steps",
        stepRecord.step_record_id,
        "record.json",
      );
      expect(existsSync(recordPath)).toBe(true);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("delivers piped stdout larger than 64 KiB and exits 0", async () => {
    // A pipe accepts about 64 KiB and then the writer has to wait. Exiting
    // in that same turn drops whatever is still queued, so the reader gets
    // a cut-off document and exit code 0. A payload only a little past one
    // buffer can still arrive whole: the parent reads the first buffer
    // before the child exits, and the kernel accepts another. Several
    // buffers is the size that gets cut. The pause between reads is what
    // keeps the pipe full while that happens. A reader that keeps up can
    // hide the cut.
    const description = "x".repeat(256 * 1024);
    const rootDir = await createEmptyTempDir();
    try {
      const stepsDir = path.join(rootDir, "features", "steps");
      await mkdir(stepsDir, { recursive: true });
      // Same stand-in the committed fixtures use. A bare "nukadoko" import
      // from a file inside this repo resolves to the package exports, which
      // point at dist/, and this test has to run before that build exists.
      const shimTarget = path.join(repoRoot, "src", "index.js");
      const shimRelative = path.relative(rootDir, shimTarget).split(path.sep).join("/");
      await writeFile(
        path.join(rootDir, "nukadoko-shim.ts"),
        `export * from "${shimRelative.startsWith(".") ? shimRelative : `./${shimRelative}`}";\n`,
      );
      await writeFile(
        path.join(stepsDir, "wide-output.ts"),
        [
          'import { z } from "zod";',
          'import { defineStep } from "../../nukadoko-shim.js";',
          "",
          "export default defineStep({",
          `  description: ${JSON.stringify(description)},`,
          "  args: z.object({}),",
          "  returns: z.object({ ok: z.boolean() }),",
          "  mutates: false,",
          "  async run() {",
          "    return { ok: true };",
          "  },",
          "});",
          "",
        ].join("\n"),
      );

      const cliPath = path.join(repoRoot, "src", "cli.ts");
        const child = spawn(process.execPath, [...sourceNodeArgs, cliPath, "steps", "--json"], {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      const stdoutDone = (async () => {
        for await (const chunk of child.stdout) {
          stdoutChunks.push(chunk as Buffer);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });
      await stdoutDone;

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      expect(exitCode).toBe(0);
      expect(withoutNoConfigLine(stderr)).toBe("");
      expect(Buffer.byteLength(stdout)).toBeGreaterThan(64 * 1024);
      const report = JSON.parse(stdout) as {
        steps: { name: string; description: string }[];
        import_failures: unknown[];
      };
      expect(report.import_failures).toEqual([]);
      expect(report.steps).toEqual([
        expect.objectContaining({
          name: "wide-output",
          description,
        }),
      ]);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it.each([
    { args: ["check", "--codes"], cwd: repoRoot },
    { args: ["steps", "--json"], cwd: fixture("basic-project") },
  ])("exits 0 with nothing on stderr when the stdout reader of `nuka $args` closes early", async ({ args, cwd }) => {
    const cliPath = path.join(repoRoot, "src", "cli.ts");
    const child = spawn(process.execPath, [...sourceNodeArgs, cliPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.destroy();
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });

    expect(withoutNoConfigLine(Buffer.concat(stderrChunks).toString("utf8"))).toBe("");
    expect(exitCode).toBe(0);
  });

  it("prints one stderr line and exits 1 when a command handler throws", async () => {
    // Node prints the uncaught-exception dump after cli.ts's top-level
    // await rejects. A runCli() call in this process can catch that
    // rejection, so the dump never appears. The child is the real entry.
    const rootDir = await createEmptyTempDir();
    try {
      await mkdir(path.join(rootDir, "features"));
      // A file where the steps directory belongs makes scaffold's mkdir
      // throw. The handler assigns that promise and does not catch it.
      await writeFile(path.join(rootDir, "features", "steps"), "not a directory\n");

      const cliPath = path.join(repoRoot, "src", "cli.ts");
        const child = spawnSync(process.execPath, [...sourceNodeArgs, cliPath, "scaffold", "fresh-step"], {
        cwd: rootDir,
        encoding: "utf8",
      });

      expect(child.status).toBe(1);
      expect(child.stdout).toBe("");
      const lines = withoutNoConfigLine(child.stderr ?? "").split("\n").filter((line) => line.length > 0);
      expect(lines).toEqual([expect.stringMatching(/^EEXIST: file already exists, mkdir /)]);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
