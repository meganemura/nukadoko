import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka do --use <receipt-id>` end to end (m6c-do-use task
// spec) against tests/fixtures/do-use-project — filling a step's own `from`
// keys from an earlier execution's receipt instead of the chain a scenario
// would have provided (docs/spec.md "Single steps (the agent path)", the
// `--use` paragraph). `from`'s own scenario-path injection mechanism is
// already covered by tests/from-chain.test.ts (m6a-from-core); this file
// only covers what's new here: reading a receipt id off the command line,
// matching it against the step actually being run's own `from`, and the
// same `used` collector recording what was actually drawn on.

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("nuka do --use", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("do-use-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fills a required from key from an earlier receipt and records it in used", async () => {
    const createStdout = createCaptureSink();
    const createExit = await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    expect(createExit).toBe(0);
    const createReceipt = JSON.parse(createStdout.text());
    expect(createReceipt.status).toBe("ok");

    const archiveStdout = createCaptureSink();
    const archiveExit = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", createReceipt.receipt_id],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(archiveExit).toBe(0);
    const archiveReceipt = JSON.parse(archiveStdout.text());
    expect(archiveReceipt.status).toBe("ok");
    // The value `--use` drew lands on the receipt's own `args`, same as a
    // scenario-path `from` injection does (tests/from-chain.test.ts) — a
    // reader must be able to tell it apart from a value never validated.
    expect(archiveReceipt.args).toEqual({ projectId: "p_acme" });
    expect(archiveReceipt.result).toEqual({ archived: true, projectId: "p_acme" });
    expect(archiveReceipt.used).toEqual([{ receipt: createReceipt.receipt_id, step: "create-project" }]);

    // Confirms the receipt actually persisted to disk carries the same shape
    // the stdout copy did (m1-secrets task spec, decision 3's own guarantee).
    const persisted = await readReceipt(rootDir, archiveReceipt.receipt_id);
    expect(persisted.used).toEqual(archiveReceipt.used);
  });

  it("--use twice: two different upstream keys both fill, both land in used in call order", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createReceipt = JSON.parse(createStdout.text());

    const ownerStdout = createCaptureSink();
    await runCli(["do", "create-owner", "--args", '{"name":"jane"}'], {
      rootDir,
      stdout: ownerStdout,
      stderr: createCaptureSink(),
    });
    const ownerReceipt = JSON.parse(ownerStdout.text());

    const archiveStdout = createCaptureSink();
    const exitCode = await runCli(
      [
        "do",
        "archive-project-with-owner",
        "--args",
        "{}",
        "--use",
        createReceipt.receipt_id,
        "--use",
        ownerReceipt.receipt_id,
      ],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const archiveReceipt = JSON.parse(archiveStdout.text());
    expect(archiveReceipt.status).toBe("ok");
    expect(archiveReceipt.args).toEqual({ projectId: "p_acme", ownerId: "o_jane" });
    expect(archiveReceipt.result).toEqual({ archived: true, projectId: "p_acme", ownerId: "o_jane" });
    expect(archiveReceipt.used).toEqual([
      { receipt: createReceipt.receipt_id, step: "create-project" },
      { receipt: ownerReceipt.receipt_id, step: "create-owner" },
    ]);
  });

  it("a failed step's receipt carries every --use'd upstream's own result (fb3-used-result task spec)", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createReceipt = JSON.parse(createStdout.text());

    const ownerStdout = createCaptureSink();
    await runCli(["do", "create-owner", "--args", '{"name":"jane"}'], {
      rootDir,
      stdout: ownerStdout,
      stderr: createCaptureSink(),
    });
    const ownerReceipt = JSON.parse(ownerStdout.text());

    const archiveStdout = createCaptureSink();
    const exitCode = await runCli(
      [
        "do",
        "archive-project-with-owner-fails",
        "--args",
        "{}",
        "--use",
        createReceipt.receipt_id,
        "--use",
        ownerReceipt.receipt_id,
      ],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(1);
    const archiveReceipt = JSON.parse(archiveStdout.text());
    expect(archiveReceipt.status).toBe("failed");
    // Both upstreams, each carrying its own full result (this task's spec,
    // decisions 3-4) — not just the first one.
    expect(archiveReceipt.used).toEqual([
      { receipt: createReceipt.receipt_id, step: "create-project", result: { id: "p_acme" } },
      { receipt: ownerReceipt.receipt_id, step: "create-owner", result: { id: "o_jane" } },
    ]);
  });

  it("--args wins over --use for the same key; a fully-overridden receipt is not cited in used", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createReceipt = JSON.parse(createStdout.text());

    const archiveStdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", '{"projectId":"explicit-id"}', "--use", createReceipt.receipt_id],
      { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const archiveReceipt = JSON.parse(archiveStdout.text());
    expect(archiveReceipt.args).toEqual({ projectId: "explicit-id" });
    expect(archiveReceipt.result).toEqual({ archived: true, projectId: "explicit-id" });
    // Nothing was actually drawn from the receipt (its one matching key was
    // already set by --args), so it is not cited (docs/spec.md "Single steps
    // (the agent path)": "the receipt ids actually drawn from land in this
    // execution's own used").
    expect(archiveReceipt.used).toBeUndefined();
  });

  it("a failed receipt passed to --use fails setup: stderr, exit 1, no receipt written", async () => {
    const failedStdout = createCaptureSink();
    const failedExit = await runCli(["do", "create-project", "--args", "{}"], {
      rootDir,
      stdout: failedStdout,
      stderr: createCaptureSink(),
    });
    expect(failedExit).toBe(1);
    const failedReceipt = JSON.parse(failedStdout.text());
    expect(failedReceipt.status).toBe("failed");

    const archiveStdout = createCaptureSink();
    const archiveStderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", failedReceipt.receipt_id],
      { rootDir, stdout: archiveStdout, stderr: archiveStderr },
    );

    expect(exitCode).toBe(1);
    // Setup-phase fatal, same family as an unregistered `from` upstream: no
    // receipt is ever printed to stdout.
    expect(archiveStdout.text()).toBe("");
    expect(archiveStderr.text()).toContain(failedReceipt.receipt_id);
    expect(archiveStderr.text()).toContain('not "ok"');
  });

  it("a receipt whose step is not named by any from entry fails setup", async () => {
    const ownerStdout = createCaptureSink();
    await runCli(["do", "create-owner", "--args", '{"name":"jane"}'], {
      rootDir,
      stdout: ownerStdout,
      stderr: createCaptureSink(),
    });
    const ownerReceipt = JSON.parse(ownerStdout.text());

    const archiveStdout = createCaptureSink();
    const archiveStderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", ownerReceipt.receipt_id],
      { rootDir, stdout: archiveStdout, stderr: archiveStderr },
    );

    expect(exitCode).toBe(1);
    expect(archiveStdout.text()).toBe("");
    expect(archiveStderr.text()).toContain(ownerReceipt.receipt_id);
    expect(archiveStderr.text()).toContain("create-owner");
  });

  it("--args may be omitted entirely when --use fills every key (fb4-args-optional task spec)", async () => {
    const createStdout = createCaptureSink();
    await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
      rootDir,
      stdout: createStdout,
      stderr: createCaptureSink(),
    });
    const createReceipt = JSON.parse(createStdout.text());

    const archiveStdout = createCaptureSink();
    const archiveStderr = createCaptureSink();
    const exitCode = await runCli(["do", "archive-project", "--use", createReceipt.receipt_id], {
      rootDir,
      stdout: archiveStdout,
      stderr: archiveStderr,
    });

    expect(exitCode).toBe(0);
    expect(archiveStderr.text()).toBe("");
    const archiveReceipt = JSON.parse(archiveStdout.text());
    expect(archiveReceipt.status).toBe("ok");
    // No --args at all means the default is `{}`, so every key on this
    // receipt's own `args` came from `--use`'s `from` injection alone.
    expect(archiveReceipt.args).toEqual({ projectId: "p_acme" });
    expect(archiveReceipt.used).toEqual([{ receipt: createReceipt.receipt_id, step: "create-project" }]);
  });

  it("neither --args nor --use: refused before any receipt is written, naming both flags", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "archive-project"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("--args");
    expect(stderr.text()).toContain("--use");
  });

  it("an unknown receipt id fails setup", async () => {
    const archiveStdout = createCaptureSink();
    const archiveStderr = createCaptureSink();
    const exitCode = await runCli(
      ["do", "archive-project", "--args", "{}", "--use", "rcpt-20260101-000000-zzzz"],
      { rootDir, stdout: archiveStdout, stderr: archiveStderr },
    );

    expect(exitCode).toBe(1);
    expect(archiveStdout.text()).toBe("");
    expect(archiveStderr.text()).toContain("rcpt-20260101-000000-zzzz");
    expect(archiveStderr.text()).toContain("no such receipt");
  });
});
