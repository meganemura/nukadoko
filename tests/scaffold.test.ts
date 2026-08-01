import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  ensureNukadokoShim,
  fixture,
  removeTempDir,
} from "./helpers/fixtures.js";

// Responsibility: `nuka scaffold <name>` (m1-init-scaffold task spec,
// decision 2) — the generated template's shape and its "fails until
// implemented" contract, name validation, the existing-file refusal, and
// the config-load-failure path scaffold shares with every other command
// that needs config (decision 3). Every test here runs `nuka init` first in
// `beforeEach`, so the very first test below — scaffold immediately after
// init, then `nuka steps` seeing the new name — *is* this task's spec's
// required "init directly followed by scaffold, then steps" integration
// walkthrough, not a separate fixture.

describe("nuka scaffold", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    const initExit = await runCli(["init"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    if (initExit !== 0) {
      throw new Error("test setup: `nuka init` failed");
    }
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs init -> scaffold -> steps end to end: the new name appears in the vocabulary", async () => {
    const scaffoldStdout = createCaptureSink();
    const scaffoldExit = await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: scaffoldStdout,
      stderr: createCaptureSink(),
    });

    expect(scaffoldExit).toBe(0);
    expect(scaffoldStdout.text().trim()).toBe(path.join("features", "steps", "send-invite.ts"));

    const filePath = path.join(rootDir, "features", "steps", "send-invite.ts");
    expect(existsSync(filePath)).toBe(true);
    const content = await readFile(filePath, "utf8");
    expect(content).toContain('from "nukadoko"');
    expect(content).toContain("TODO: describe send-invite");
    expect(content).not.toMatch(/pattern/);

    const stepsStdout = createCaptureSink();
    const stepsExit = await runCli(["steps", "--json"], {
      rootDir,
      stdout: stepsStdout,
      stderr: createCaptureSink(),
    });
    expect(stepsExit).toBe(0);
    const summaries = JSON.parse(stepsStdout.text());
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "send-invite",
          patterns: [],
          mutates: true,
          description: "TODO: describe send-invite",
        }),
      ]),
    );
  });

  it("fails until implemented: `nuka do` exits 1 with a failed receipt", async () => {
    await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "send-invite", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const receipt = JSON.parse(stdout.text());
    expect(receipt.status).toBe("failed");
    expect(receipt.error.message).toBe("not implemented: send-invite");
  });

  it("rejects a name outside [a-z0-9-]+, writing nothing", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["scaffold", "Bad_Name"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toBe("");
    expect(existsSync(path.join(rootDir, "features", "steps", "Bad_Name.ts"))).toBe(false);
  });

  it("refuses to overwrite an existing step file", async () => {
    await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    const filePath = path.join(rootDir, "features", "steps", "send-invite.ts");
    const original = await readFile(filePath, "utf8");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["scaffold", "send-invite"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toBe("");
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("exits 1 when the project's config fails to load", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["scaffold", "send-invite"], {
      rootDir: fixture("invalid-config-project"),
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("typo");
  });
});
