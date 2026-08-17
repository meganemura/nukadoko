import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { NukadokoConfig } from "../src/config/schema.js";
import { buildStepFixtures, createStepContext } from "../src/context/create-context.js";
import { PartNotDeclaredError, UnregisteredStepError } from "../src/context/errors.js";
import { defineStep, type Step } from "../src/step/define-step.js";
import { registeredStepPredicate } from "../src/step/validate-from.js";

// Responsibility: `ctx.call`'s two refusals that need a plain-JS side
// channel to prove "the part never actually ran", not just "the call
// threw" (docs/spec.md "Parts") — a `run` closure setting a `ran` flag,
// exercised directly against `createStepContext` rather than through
// tests/parts.test.ts's own step-record-only assertions.
//
// The unregistered-part case additionally has no natural way to arise
// through ordinary authoring at all — docs/spec.md "Chaining steps" names
// it as "almost always ... reached through a different `await import()`"
// — which is the other reason it lives here rather than as a real fixture
// step file, the same way tests/validate-from.test.ts already proves the
// equivalent case for `from` without a real double-import fixture
// (`registeredStepPredicate` excluding the part on purpose, standing in
// for the module-identity mismatch).

function baseConfig(): NukadokoConfig {
  return {
    featuresDir: "features",
    additionalFeatureDirs: [],
    stateDir: ".nukadoko",
    envFiles: [],
    parameterTypes: [],
    fixtures: {},
    fixtureTimeout: 60_000,
    secrets: { public: [], redact: [] },
    browserType: "chromium",
  };
}

const emptySchema = z.object({});

describe("ctx.call: unregistered part", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("throws UnregisteredStepError for a part declared in parts but never registered, and records no CallEntry", async () => {
    const part = defineStep({
      description: "a part reached through a mismatched module instance",
      args: emptySchema,
      returns: emptySchema,
      async run() {
        return {};
      },
    });
    const composite = defineStep({
      description: "declares part but discovery never registered it",
      args: emptySchema,
      returns: emptySchema,
      parts: [part],
      async run({ call }) {
        await call(part, {});
        return {};
      },
    });

    // `part` deliberately excluded from the registered set — the same fact
    // a step file reached through a second, separate `await import()` would
    // produce.
    const isRegisteredStep = registeredStepPredicate([composite]);
    const stepNameOf: Map<Step, string> = new Map([[composite, "composite"]]);

    const { ctx, callsSnapshot, beginStepRun } = createStepContext({
      config: baseConfig(),
      evidenceDir,
      env: {},
      isRegisteredStep,
      stepNameOf: (step) => stepNameOf.get(step),
    });

    const fixtures = await buildStepFixtures(ctx, ["call"]);
    beginStepRun(composite, fixtures);

    await expect(composite.run(fixtures, {})).rejects.toThrow(UnregisteredStepError);
    expect(callsSnapshot()).toEqual([]);
  });
});

describe("ctx.call: undeclared part", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("throws PartNotDeclaredError for a Step the caller never listed in parts, and never runs it", async () => {
    let ran = false;
    const part = defineStep({
      description: "a part that must never actually run here",
      args: emptySchema,
      returns: emptySchema,
      async run() {
        ran = true;
        return {};
      },
    });
    const composite = defineStep({
      description: "never declares part in its own parts",
      args: emptySchema,
      returns: emptySchema,
      // Deliberately `[]`: `part` is registered and importable, but this
      // step never named it as one of its own parts — the mistake docs/
      // spec.md "Parts" describes as refused "before it ever runs", proven
      // here by `ran` staying `false`, not merely by the throw itself
      // (tests/parts.test.ts's own e2e assertion for this same refusal has
      // no such side channel to check against).
      parts: [],
      async run({ call }) {
        await call(part, {});
        return {};
      },
    });

    const isRegisteredStep = registeredStepPredicate([composite, part]);
    const stepNameOf: Map<Step, string> = new Map([
      [composite, "composite"],
      [part, "part"],
    ]);

    const { ctx, callsSnapshot, beginStepRun } = createStepContext({
      config: baseConfig(),
      evidenceDir,
      env: {},
      isRegisteredStep,
      stepNameOf: (step) => stepNameOf.get(step),
    });

    const fixtures = await buildStepFixtures(ctx, ["call"]);
    beginStepRun(composite, fixtures);

    await expect(composite.run(fixtures, {})).rejects.toThrow(PartNotDeclaredError);
    expect(ran).toBe(false);
    expect(callsSnapshot()).toEqual([]);
  });
});
