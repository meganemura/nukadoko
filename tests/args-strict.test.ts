import path from "node:path";
import { request as playwrightRequest, type APIRequestContext } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { recordStep } from "../src/external/record-step.js";
import { readStepRecord } from "../src/record/read-step-record.js";
import { defineStep } from "../src/step/define-step.js";
import { z } from "zod";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka describe` publishes a step's `args` as JSON Schema
// via `z.toJSONSchema`, which renders a plain `z.object(...)` as
// `additionalProperties: false` — but a zod object's own default parse mode
// for an unrecognized key is "strip", not "reject", so the published
// contract and the runtime used to disagree: an extra key was silently
// dropped (and, worse, still landed in a step record's own `args`) instead
// of being refused. This file covers the fix (src/step/strict-args.ts)
// across the three execution paths that turn a step's `args` into a
// validated value: `nuka do` (src/cli/do.ts), `nuka run`
// (src/run/run-scenario.ts), and `recordStep`
// (src/external/record-step.ts). Each path gets the same pair of tests —
// an extra key refused, naming it, and the same call with only the
// declared keys still accepted — so passing proves the fix discriminates
// rather than just refusing everything.
//
// Each path also gets one more test: a passing step record's own `args`
// holds the schema-validated value, not the caller's raw one. Every step
// above uses a step whose own args schema has no `.default(...)`, so a raw
// value and a validated one are always identical there — passing already
// proves extra-key rejection, but not which of the two values a step
// record actually carries. The extra tests below use a step whose args
// schema fills a default the caller never supplies, which is the one case
// where the two values provably differ.

describe("nuka do: strict args validation", () => {
  it("rejects an extra key echo's args schema does not declare, naming it in the failed step record", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "echo", "--args", JSON.stringify({ value: "hi", EXTRA_KEY: "should be rejected" })],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(1);
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("failed");
      expect(stepRecord.error.kind).toBe("args_invalid");
      expect(stepRecord.error.message).toContain("EXTRA_KEY");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("still accepts the same call with only the declared key", async () => {
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
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("ok");
      expect(stepRecord.args).toEqual({ value: "hi" });
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("does not treat a --use-filled key as extra, but still rejects a genuinely extra key given alongside it", async () => {
    const rootDir = await copyFixtureToTempDir("do-use-project");
    try {
      const createStdout = createCaptureSink();
      const createExit = await runCli(["do", "create-project", "--args", '{"name":"acme"}'], {
        rootDir,
        stdout: createStdout,
        stderr: createCaptureSink(),
      });
      expect(createExit).toBe(0);
      const createStepRecord = JSON.parse(createStdout.text());

      // `archive-project`'s own args schema is `{ projectId: string }`
      // (tests/fixtures/do-use-project/features/steps/archive-project.ts);
      // `--use` fills `projectId`, and `BOGUS` is the one key this schema
      // never declares.
      const archiveStdout = createCaptureSink();
      const archiveExit = await runCli(
        [
          "do",
          "archive-project",
          "--args",
          JSON.stringify({ BOGUS: "not a real key" }),
          "--use",
          createStepRecord.step_record_id,
        ],
        { rootDir, stdout: archiveStdout, stderr: createCaptureSink() },
      );

      expect(archiveExit).toBe(1);
      const archiveStepRecord = JSON.parse(archiveStdout.text());
      expect(archiveStepRecord.status).toBe("failed");
      expect(archiveStepRecord.error.kind).toBe("args_invalid");
      expect(archiveStepRecord.error.message).toContain("BOGUS");
      // `projectId` — filled by `--use`, not typed on the command line at
      // all — is never named as unrecognized: only the genuinely extra key is.
      expect(archiveStepRecord.error.message).not.toContain("projectId");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("records the schema-validated args, including a filled default, on a passing step record", async () => {
    const rootDir = await copyFixtureToTempDir("do-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["do", "greet-with-default", "--args", JSON.stringify({ name: "ada" })], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(0);
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("ok");
      // `tag` was never given on the command line: this is the schema's own
      // default, present only if the record holds the validated value.
      expect(stepRecord.args).toEqual({ name: "ada", tag: "guest" });
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("nuka run: strict args validation", () => {
  it("rejects a scenario step whose pattern captures a key its args schema does not declare", async () => {
    const rootDir = await copyFixtureToTempDir("args-strict-run-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/greet.feature"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const lines = stdout.text().split("\n").filter((line) => line.length > 0);
      const scenarioRecord = JSON.parse(lines[0]!);
      expect(scenarioRecord.status).toBe("failed");
      expect(scenarioRecord.steps).toHaveLength(2);

      // Both steps run as one scenario (tests/fixtures/args-strict-run-
      // project/features/greet.feature): the first uses the pattern that
      // captures only `name` (declared), the second the pattern that also
      // captures `tag` (not declared).
      const [okSummary, rejectedSummary] = scenarioRecord.steps;
      expect(okSummary.status).toBe("passed");
      expect(rejectedSummary.status).toBe("failed");
      expect(rejectedSummary.error.message).toContain("tag");

      const okStepRecord = readStepRecord(
        path.join(rootDir, ".nukadoko", "records", "steps", okSummary.step_record_id),
      );
      expect(okStepRecord?.args).toEqual({ name: "ada" });

      const rejectedStepRecord = readStepRecord(
        path.join(rootDir, ".nukadoko", "records", "steps", rejectedSummary.step_record_id),
      );
      expect((rejectedStepRecord as { error: { kind: string } } | null)?.error.kind).toBe("args_invalid");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("records the schema-validated args, including a filled default, on a passing step record", async () => {
    const rootDir = await copyFixtureToTempDir("args-strict-run-project");
    try {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/defaults.feature"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(0);
      const lines = stdout.text().split("\n").filter((line) => line.length > 0);
      const scenarioRecord = JSON.parse(lines[0]!);
      expect(scenarioRecord.status).toBe("passed");
      const [stepSummary] = scenarioRecord.steps;
      expect(stepSummary.status).toBe("passed");

      const stepRecord = readStepRecord(
        path.join(rootDir, ".nukadoko", "records", "steps", stepSummary.step_record_id),
      );
      // The pattern never captures `tag`: this is the schema's own default,
      // present only if the record holds the validated value.
      expect(stepRecord?.args).toEqual({ name: "ada", tag: "anon" });
    } finally {
      await removeTempDir(rootDir);
    }
  });
});

describe("recordStep: strict args validation", () => {
  let rootDir: string;
  let requestContext: APIRequestContext;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("external-driver-project");
    // Never actually dialed: every step in this describe block declines
    // every fixture (`run({}, args)`), so `request` only has to exist to
    // satisfy `RecordStepOptions`'s own required field.
    requestContext = await playwrightRequest.newContext({ baseURL: "http://127.0.0.1:1" });
  });

  afterEach(async () => {
    await requestContext.dispose();
    await removeTempDir(rootDir);
  });

  const cartIdStep = defineStep({
    description: "requires a cartId, to exercise strict extra-key rejection",
    args: z.object({ cartId: z.string() }),
    returns: z.object({ cartId: z.string() }),
    async run({}, args) {
      return { cartId: args.cartId };
    },
  });

  it("accepts exactly the declared args key", async () => {
    const { result } = await recordStep(cartIdStep, { cartId: "c1" }, {
      name: "cart-id-step",
      rootDir,
      request: requestContext,
    });
    expect(result).toEqual({ cartId: "c1" });
  });

  it("rejects the same call with one extra key added, naming it", async () => {
    await expect(
      recordStep(
        cartIdStep,
        // @ts-expect-error deliberately an extra key `cartIdStep.args` does not declare
        { cartId: "c1", EXTRA: "nope" },
        { name: "cart-id-step", rootDir, request: requestContext },
      ),
    ).rejects.toThrow(/args validation failed.*EXTRA/s);
  });

  it("does not treat a use-filled key as extra", async () => {
    const producerStep = defineStep({
      description: "Produce a projectId",
      args: z.object({}),
      returns: z.object({ projectId: z.string() }),
      async run() {
        return { projectId: "p1" };
      },
    });
    const consumerStep = defineStep({
      description: "Consume a projectId via use",
      args: z.object({ projectId: z.string() }),
      returns: z.object({ projectId: z.string() }),
      from: { projectId: [producerStep, "projectId"] },
      async run({}, args) {
        return { projectId: args.projectId };
      },
    });

    const produced = await recordStep(producerStep, {}, {
      name: "producer-step",
      rootDir,
      request: requestContext,
    });
    const consumed = await recordStep(consumerStep, {}, {
      name: "consumer-step",
      rootDir,
      request: requestContext,
      use: [produced.stepRecordId],
    });

    expect(consumed.result).toEqual({ projectId: "p1" });
  });

  it("records the schema-validated args, including a filled default, on a passing step record", async () => {
    const couponStep = defineStep({
      description: "requires a cartId, defaults couponCode when the caller omits it",
      args: z.object({ cartId: z.string(), couponCode: z.string().default("NONE") }),
      returns: z.object({ cartId: z.string(), couponCode: z.string() }),
      async run({}, args) {
        return { cartId: args.cartId, couponCode: args.couponCode };
      },
    });

    const { stepRecordId } = await recordStep(couponStep, { cartId: "c1" }, {
      name: "coupon-step",
      rootDir,
      request: requestContext,
    });

    const stepRecord = readStepRecord(path.join(rootDir, ".nukadoko", "records", "steps", stepRecordId));
    // `couponCode` was never given: this is the schema's own default,
    // present only if the record holds the validated value.
    expect(stepRecord?.args).toEqual({ cartId: "c1", couponCode: "NONE" });
  });
});
