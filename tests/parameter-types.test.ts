import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { loadConfig } from "../src/config/load-config.js";
import { discoverSteps } from "../src/discover/discover-steps.js";
import { bindStepArgs, buildStepBindings, matchPickleStep } from "../src/run/match-step.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: m2pre-parameter-types task spec, scope item 2's two
// end-to-end items, both against tests/fixtures/parameter-types-project
// (its nukadoko.config.ts registers docs/spec.md's `negation` and
// `from-dir` examples verbatim) — proving the whole config -> registry ->
// matching -> zod wiring, not just the schema/registry unit pieces already
// covered by tests/load-config.test.ts and tests/binding-expression.test.ts.
//
// The negation case is exercised through the matching pipeline directly
// (loadConfig -> discoverSteps -> buildStepBindings -> matchPickleStep ->
// bindStepArgs -> the step's own args.safeParse) rather than through `nuka
// do`: `nuka do` addresses a step by name and takes its args as JSON
// directly (docs/spec.md "Running": "the agent path"), it never matches
// pattern text against pickle-step-shaped input, so there is no CLI
// invocation this claim could go through instead. This is read-only (no
// receipt/state is written), so it runs directly against the committed
// fixture, same as tests/load-config.test.ts's own convention.
describe("config.parameterTypes: negation reaches a step's args as a real boolean", () => {
  it("matches `will return`/`will not return`, binds, and validates through the step's own zod schema", async () => {
    const rootDir = fixture("parameter-types-project");
    const config = await loadConfig(rootDir);
    const vocabulary = await discoverSteps(rootDir, config.featuresDir);
    const bindings = buildStepBindings(vocabulary, config.parameterTypes);

    const entry = vocabulary.get("thing-will-return");
    expect(entry).toBeDefined();

    const negated = matchPickleStep("the job will not return", bindings);
    expect(negated.kind).toBe("matched");
    if (negated.kind !== "matched") return;
    const negatedBind = bindStepArgs(
      negated.stepName,
      negated.captures,
      negated.values,
      undefined,
      entry!.step.args,
    );
    expect(negatedBind.ok).toBe(true);
    if (!negatedBind.ok) return;
    const negatedParsed = entry!.step.args.safeParse(negatedBind.value);
    expect(negatedParsed.success).toBe(true);
    if (negatedParsed.success) {
      expect(negatedParsed.data).toEqual({ negated: true });
    }

    const plain = matchPickleStep("the job will return", bindings);
    expect(plain.kind).toBe("matched");
    if (plain.kind !== "matched") return;
    const plainBind = bindStepArgs(
      plain.stepName,
      plain.captures,
      plain.values,
      undefined,
      entry!.step.args,
    );
    expect(plainBind.ok).toBe(true);
    if (!plainBind.ok) return;
    const plainParsed = entry!.step.args.safeParse(plainBind.value);
    expect(plainParsed.success).toBe(true);
    if (plainParsed.success) {
      expect(plainParsed.data).toEqual({ negated: false });
    }
  });
});

// `nuka check`/`nuka run` both write real state (`nuka run` writes
// receipts/scenario records under `.nukadoko/`), so — same convention as
// tests/run.test.ts — this runs against a fresh temp copy, never the
// committed fixture directly.
describe("config.parameterTypes: from-dir folds the with/without location-clause variants into one step", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("parameter-types-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka check is green (zero errors, zero warnings)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text());
    expect(report).toEqual({ errors: [], warnings: [] });
    expect(exitCode).toBe(0);
  });

  it("nuka run executes both the with- and without-location-clause scenarios", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/from-dir.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    expect(exitCode).toBe(0);

    const lines = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);

    const records = lines.map((line) => JSON.parse(line));
    for (const record of records) {
      expect(record.status).toBe("passed");
      expect(record.steps).toHaveLength(1);
      expect(record.steps[0].status).toBe("passed");
    }

    const withoutClause = records.find((r) => r.scenario === "list items with no location clause");
    const withClause = records.find((r) => r.scenario === "list items with a location clause");
    expect(withoutClause).toBeDefined();
    expect(withClause).toBeDefined();
  });
});
