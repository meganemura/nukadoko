import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readStepRecord } from "../src/record/read-step-record.js";
import { defineStep } from "../src/step/define-step.js";
import { strictArgsSchema } from "../src/step/strict-args.js";
import { z } from "zod";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka describe` publishes a step's `args` as JSON Schema
// via `z.toJSONSchema`, which renders a plain `z.object(...)` as
// `additionalProperties: false` — but a zod object's own default parse mode
// for an unrecognized key is "strip", not "reject", so the published
// contract and the runtime used to disagree: an extra key was silently
// dropped (and, worse, still landed in a step record's own `args`) instead
// of being refused. This file covers the fix (src/step/strict-args.ts)
// across the two execution paths that turn a step's `args` into a
// validated value: `nuka do` (src/cli/do.ts) and `nuka run`
// (src/run/run-scenario.ts). Each path gets the same pair of tests —
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
//
// The other half of the same contract is a schema that already says what
// an extra key is. `z.toJSONSchema` (what `nuka describe` publishes)
// renders `z.looseObject` and `.passthrough()` as `additionalProperties:
// {}`, and `.catchall(z.number())` as `additionalProperties: { type:
// "number" }`. `strictArgsSchema` is what `nuka do` and `nuka run`
// parse against, so those two have to accept exactly what
// that published shape accepts. A plain `z.object` and a `z.strictObject`
// stay `additionalProperties: false`. The extra key and its value are
// drawn: one hand-picked pair would only pin the key its author typed.

const extraKey = gs.text({ minSize: 1, maxSize: 12, alphabet: "xyz012" });
const extraValue = gs.oneOf(
  gs.integers({ minValue: -1000, maxValue: 1000 }).map((value) => value as unknown),
  gs.text({ maxSize: 8, alphabet: "abc" }).map((value) => value as unknown),
  gs.booleans().map((value) => value as unknown),
  gs.just(null as unknown),
);

function publishedAdditional(schema: z.ZodType): unknown {
  return (z.toJSONSchema(schema) as { readonly additionalProperties?: unknown }).additionalProperties;
}

describe("strictArgsSchema matches the contract nuka describe publishes", () => {
  it("keeps a loose object's extra keys, the shape describe publishes as additionalProperties: {}", () =>
    hegel.test((tc) => {
      const key = tc.draw(extraKey);
      const value = tc.draw(extraValue);
      const input = { name: "a", [key]: value };
      for (const schema of [z.looseObject({ name: z.string() }), z.object({ name: z.string() }).passthrough()]) {
        expect(publishedAdditional(schema)).toEqual({});
        const parsed = strictArgsSchema(schema).safeParse(input);
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data).toEqual(input);
      }
    }));

  it("keeps a numeric catchall and refuses a non-number, matching the published additionalProperties schema", () =>
    hegel.test((tc) => {
      const key = tc.draw(extraKey);
      const schema = z.object({ name: z.string() }).catchall(z.number());
      expect(publishedAdditional(schema)).toEqual({ type: "number" });

      const n = tc.draw(gs.integers({ minValue: -1000, maxValue: 1000 }));
      const accepted = strictArgsSchema(schema).safeParse({ name: "a", [key]: n });
      expect(accepted.success).toBe(true);
      if (accepted.success) expect(accepted.data).toEqual({ name: "a", [key]: n });

      const text = tc.draw(gs.text({ minSize: 1, maxSize: 8, alphabet: "abc" }));
      const rejected = strictArgsSchema(schema).safeParse({ name: "a", [key]: text });
      expect(rejected.success).toBe(false);
      if (!rejected.success) {
        const message = rejected.error.issues.map((issue) => issue.message).join("\n");
        expect(message).not.toContain("Unrecognized key");
      }
    }));

  it("keeps a plain object and a strict object closed, matching additionalProperties: false", () =>
    hegel.test((tc) => {
      const key = tc.draw(extraKey);
      const value = tc.draw(extraValue);
      for (const schema of [
        z.object({ name: z.string() }),
        z.strictObject({ name: z.string() }),
        z.object({ name: z.string() }).strict(),
      ]) {
        expect(publishedAdditional(schema)).toEqual(false);
        const parsed = strictArgsSchema(schema).safeParse({ name: "a", [key]: value });
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          expect(parsed.error.issues.map((issue) => issue.message).join("\n")).toContain(key);
        }
      }
    }));
});

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
      expect(stepRecord.status).toBe("passed");
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
      expect(stepRecord.status).toBe("passed");
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
      const exitCode = await runCli(["run", "--no-check", "features/greet.feature"], {
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
      const exitCode = await runCli(["run", "--no-check", "features/defaults.feature"], {
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
