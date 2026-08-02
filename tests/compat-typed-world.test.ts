import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { discoverSteps } from "../src/discover/discover-steps.js";
import { DuplicateWorldDefinitionError } from "../src/discover/errors.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: m2c-typed-world task spec's own coverage — the compat
// World's "measurement is always on, declaration is opt-in" mechanism
// (typed-world-design.md's "機構" section; proto-typed-world/findings.md's
// verified own-data-defineProperty variant, `wrapDefinePropertySeeded`).
//
//   - Measurement: a compat step's own reads/writes of an ordinary bag
//     field land on that step's receipt (`receipt.world`), deduplicated, in
//     access order; a step that never touches the World gets no `world`
//     field at all.
//   - Reconcile's own documented limit: an undeclared key created mid-step
//     is invisible to that same step's own receipt, and only starts being
//     measured from the *next* step onward.
//   - Declaration (`defineWorld`): a valid declared write passes and is
//     measured; an invalid one fails the step and is never recorded as a
//     write.
//   - Reserved keys (`attach`/`log`/`link`/`parameters`): declaring one
//     through `defineWorld`, or reassigning one at run time, are both
//     errors — the former at discovery, the latter at execution.
//   - The `#private` integration test proto-typed-world/findings.md's own
//     central claim rests on: a private field stays reachable through a
//     method with no crash, alongside ordinary bag-field measurement.
//   - A typed-only scenario's receipts are unaffected (no `world` field at
//     all — a typed step has no `this`).

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("nuka run: typed World measurement + declaration", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("typed-world-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("measures a bag field's reads/writes, deduplicated and in order; a step that never touches the World gets no world field", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/measurement.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    const measured = records.find((r) => r.scenario.startsWith("a bag field write and read"));
    const untouched = records.find((r) => r.scenario.startsWith("a step that never touches"));

    expect(measured.status).toBe("passed");
    const firstIncrement = await readReceipt(rootDir, measured.steps[0].receipt);
    // Reads visits (0), then writes it (1) — one read, one write, in order.
    expect(firstIncrement.world).toEqual({ reads: ["visits"], writes: ["visits"] });

    const secondIncrement = await readReceipt(rootDir, measured.steps[1].receipt);
    expect(secondIncrement.world).toEqual({ reads: ["visits"], writes: ["visits"] });

    const finalCheck = await readReceipt(rootDir, measured.steps[2].receipt);
    // Reads only (the assertion step never writes) — deduplicated to one
    // entry despite reading `this.visits` twice in its own `if` condition.
    expect(finalCheck.world).toEqual({ reads: ["visits"], writes: [] });

    expect(untouched.status).toBe("passed");
    const untouchedReceipt = await readReceipt(rootDir, untouched.steps[0].receipt);
    expect(untouchedReceipt.world).toBeUndefined();
  });

  it("an undeclared key created mid-step is not in that step's own receipt, but is measured from the next step onward", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/measurement.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    const scenario = records.find((r) => r.scenario.startsWith("an undeclared key introduced"));
    expect(scenario.status).toBe("passed");

    const creationReceipt = await readReceipt(rootDir, scenario.steps[0].receipt);
    // The write happened, but the accessor didn't exist yet — not measured,
    // and not recorded at all (proto-typed-world/findings.md's "hole 1").
    expect(creationReceipt.world).toBeUndefined();

    const readReceiptBody = await readReceipt(rootDir, scenario.steps[1].receipt);
    expect(readReceiptBody.world).toEqual({ reads: ["freshField"], writes: [] });
  });

  it("a #private field stays reachable through a method (no crash), the central proto-typed-world claim", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/measurement.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    const scenario = records.find((r) => r.scenario.startsWith("a #private field stays"));
    expect(scenario.status).toBe("passed");
    expect(scenario.steps[0].status).toBe("passed");
  });

  it("a valid declared write passes and is measured; an invalid one fails the step and is never recorded as a write", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/declared.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    const valid = records.find((r) => r.scenario.startsWith("a valid declared write"));
    const invalid = records.find((r) => r.scenario.startsWith("an invalid declared write"));

    expect(valid.status).toBe("passed");
    const writeReceipt = await readReceipt(rootDir, valid.steps[0].receipt);
    expect(writeReceipt.world).toEqual({ reads: [], writes: ["listing"] });
    const readBackReceipt = await readReceipt(rootDir, valid.steps[1].receipt);
    expect(readBackReceipt.world).toEqual({ reads: ["listing"], writes: [] });

    expect(invalid.status).toBe("failed");
    expect(invalid.steps[0].status).toBe("failed");
    expect(invalid.steps[0].error.message).toContain("listing");
    const invalidReceipt = await readReceipt(rootDir, invalid.steps[0].receipt);
    expect(invalidReceipt.status).toBe("failed");
    // The invalid write must never appear in world.writes (proto-typed-
    // world/findings.md Q1's bug, regularized).
    expect(invalidReceipt.world).toBeUndefined();
    // m3a-receipt-kinds task spec: identified by type
    // (`WorldWriteValidationError`), never by matching the message —
    // distinct from "step_error" (an ordinary throw from a compat step's
    // own glue).
    expect((invalidReceipt as { error: { kind: string } }).error.kind).toBe("world_invalid");
  });

  it("reassigning a reserved key at run time fails the step with a clear runtime error", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/reserved.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toContain("attach");
    expect(record.steps[0].error.message).toContain("reserved");
    // m3a-receipt-kinds task spec: `ReservedWorldKeyWriteError` isn't one of
    // the nine named kinds (only a declared-schema failure, thrown by
    // `WorldWriteValidationError`, is "world_invalid") — this must stay
    // "step_error", not be swept into "world_invalid" just because it's
    // also a World-related throw.
    const receipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect((receipt as { error: { kind: string } }).error.kind).toBe("step_error");
  });
});

describe("nuka run: a typed-only scenario is unaffected", () => {
  it("a typed step's receipt has no world field at all", async () => {
    const rootDir = await copyFixtureToTempDir("run-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/passing.feature"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(0);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      expect(record.status).toBe("passed");
      for (const step of record.steps) {
        const receipt = await readReceipt(rootDir, step.receipt);
        expect(receipt.world).toBeUndefined();
      }
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("discoverSteps: defineWorld registration errors", () => {
  it("throws DuplicateWorldDefinitionError when defineWorld is called more than once in a run", async () => {
    await expect(
      discoverSteps(fixture("typed-world-duplicate-project"), "features"),
    ).rejects.toBeInstanceOf(DuplicateWorldDefinitionError);
  });

  it("throws ReservedWorldKeyDeclaredError when a defineWorld schema names a reserved key", async () => {
    // Message match, not `toBeInstanceOf`: this error is thrown from inside
    // src/compat/define-world.ts, loaded through discovery's own scoped tsx
    // import (a separate module realm from this test file's plain top-level
    // import of the same source — see src/compat/registry.ts's own header
    // for why identity doesn't cross that boundary), the same reason
    // tests/poll.test.ts and others match on message here too.
    await expect(
      discoverSteps(fixture("typed-world-reserved-schema-project"), "features"),
    ).rejects.toThrow(/reserved/i);
  });
});
