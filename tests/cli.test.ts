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
    const summaries = JSON.parse(stdout.text());
    expect(summaries).toEqual(
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
    expect(summaries).toHaveLength(3);
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
  it("executes a pure ok step and writes a receipt", async () => {
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
      const receipt = JSON.parse(stdout.text());
      expect(receipt.status).toBe("ok");
      expect(receipt.step).toBe("echo");
      expect(receipt.kind).toBe("do");
      expect(receipt.args).toEqual({ value: "hi" });
      expect(receipt.result).toEqual({ value: "hi" });
      expect(receipt.environment).toBe("default");
      expect(receipt.session).toBeNull();
      expect(receipt.scenario).toBeNull();
      expect(receipt.evidence.dir).toBe(path.join(".nukadoko", "receipts", receipt.receipt_id));
      expect(receipt.evidence.screenshots).toEqual([]);
      expect(receipt.evidence.trace).toBeUndefined();
      expect(receipt.evidence.http).toBeUndefined();
      // No network call was ever made (this task's spec, decision 3):
      // `observed` is still always present on the receipt, at zero.
      expect(receipt.observed).toEqual({ http_reads: 0, http_writes: 0 });
      // `echo` declares `mutates: false` explicitly (m3a-receipt-kinds task
      // spec, decision 3): a typed step's receipt carries that declaration
      // verbatim, never `null` (`null` is reserved for a compat step, which
      // has no declaration at all).
      expect(receipt.mutates).toBe(false);

      const receiptPath = path.join(rootDir, receipt.evidence.dir, "receipt.json");
      expect(existsSync(receiptPath)).toBe(true);
      const onDisk = JSON.parse(await readFile(receiptPath, "utf8"));
      expect(onDisk).toEqual(receipt);
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

  it("an unknown flag fails setup: exit 1, stderr names it, no receipt written (yargs runs the matched handler after .fail() unless run-cli.ts guards it)", async () => {
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

  it("writes a failed receipt with exit 1 when args fail schema validation", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["do", "echo", "--args", "{}"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const receipt = JSON.parse(stdout.text());
      expect(receipt.status).toBe("failed");
      expect(receipt.result).toBeUndefined();
      expect(receipt.error.message).toBeTruthy();
      // m3a-receipt-kinds task spec: args validation failure classifies as
      // "args_invalid", distinct from an ordinary step throw.
      expect(receipt.error.kind).toBe("args_invalid");
      expect(existsSync(path.join(rootDir, receipt.evidence.dir, "receipt.json"))).toBe(true);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("writes a failed receipt with exit 1 when run throws", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["do", "throws", "--args", "{}"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const receipt = JSON.parse(stdout.text());
      expect(receipt.status).toBe("failed");
      expect(receipt.error.message).toBe("boom");
      // m3a-receipt-kinds task spec: an ordinary step throw is the
      // catch-all "step_error", distinct from every contract-layer kind.
      expect(receipt.error.kind).toBe("step_error");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("writes a failed receipt with exit 1 when the result fails its returns schema", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["do", "bad-returns", "--args", "{}"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const receipt = JSON.parse(stdout.text());
      expect(receipt.status).toBe("failed");
      expect(receipt.error.message).toContain("returns");
      // m3a-receipt-kinds task spec: a returns-schema failure classifies as
      // "result_invalid", distinct from "args_invalid"/"step_error".
      expect(receipt.error.kind).toBe("result_invalid");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("does not create a receipts directory for an unknown step", async () => {
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

  it("does not create a receipts directory for malformed --args JSON", async () => {
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
      const receipt = JSON.parse(stdout.text());
      expect(receipt.status).toBe("ok");
      expect(receipt.result).toEqual({ id: "p_0001", name: "x" });

      const receiptPath = path.join(
        rootDir,
        ".nukadoko",
        "receipts",
        receipt.receipt_id,
        "receipt.json",
      );
      expect(existsSync(receiptPath)).toBe(true);
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
    const summaries = JSON.parse(stdout);
    expect(summaries.map((s: { name: string }) => s.name).sort()).toEqual([
      "create-project",
      "get-project",
      "list-projects",
    ]);
  });

  it("runs `do` end-to-end via tsx against a fixture project, receipt.json included", async () => {
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
      const receipt = JSON.parse(stdout);
      expect(receipt.status).toBe("ok");
      expect(receipt.result).toEqual({ id: "p_0001", name: "x" });

      const receiptPath = path.join(
        rootDir,
        ".nukadoko",
        "receipts",
        receipt.receipt_id,
        "receipt.json",
      );
      expect(existsSync(receiptPath)).toBe(true);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
