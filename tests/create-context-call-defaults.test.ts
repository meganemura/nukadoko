import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { NukadokoConfig } from "../src/config/schema.js";
import { buildStepFixtures, createStepContext } from "../src/context/create-context.js";
import { defineStep } from "../src/step/define-step.js";

// Responsibility: tests/create-context.test.ts covers ctx.request()/
// ctx.requireEnv(); tests/call-unregistered.test.ts covers ctx.call's two
// declared-refusal paths (PartNotDeclaredError/UnregisteredStepError), both
// against createStepContext directly, the same pattern this file follows.
// This file covers what neither reaches: createStepContext's own harmless
// defaults for resultOf/isRegisteredStep/stepNameOf/refuseMutatingPart when
// an executor omits them (`nuka do`'s own contract, docs/spec.md "Context
// API": undefined under `nuka do`), ctx.call's internal-invariant guards
// (called before beginStepRun; a fixture bag missing a name the part's own
// run destructures), the two outcomes `ctx.call` must still report
// correctly (the part's own run() throwing, and the part's own result
// failing its returns schema), and `ctx.call`'s own strict-args enforcement
// (an unrecognized key refused, naming it, while `CallEntry.args` still
// records whatever raw value `call()` was actually given).

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

describe("createStepContext: harmless defaults when the executor supplies none", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("ctx.resultOf() returns undefined (default isRegisteredStep -> true, default resultOf -> undefined)", () => {
    const unrelated = defineStep({
      description: "never resolved by anything",
      args: emptySchema,
      returns: emptySchema,
      async run() {
        return {};
      },
    });
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });

    expect(ctx.resultOf(unrelated)).toBeUndefined();
  });

  it("ctx.call() succeeds with the default stepNameOf/refuseMutatingPart (no executor-supplied hooks at all)", async () => {
    const part = defineStep({
      description: "a part run with every createStepContext hook left at its default",
      args: emptySchema,
      returns: emptySchema,
      async run() {
        return {};
      },
    });
    const composite = defineStep({
      description: "calls part with nothing but the built-in defaults wired in",
      args: emptySchema,
      returns: emptySchema,
      parts: [part],
      async run({ call }) {
        return call(part, {});
      },
    });

    const { ctx, beginStepRun } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const fixtures = await buildStepFixtures(ctx, ["call"]);
    beginStepRun(composite, fixtures);

    await expect(composite.run(fixtures, {})).resolves.toEqual({});
  });
});

describe("ctx.call: internal-invariant guards", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("throws when called before beginStepRun ever ran (no active step boundary)", async () => {
    const part = defineStep({
      description: "irrelevant, never reached",
      args: emptySchema,
      returns: emptySchema,
      async run() {
        return {};
      },
    });
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });

    await expect(ctx.call(part, {})).rejects.toThrow(/no active step boundary/);
  });

  it("throws when the current fixture bag is missing a name the part's own run() destructures", async () => {
    const part = defineStep({
      description: "destructures env, deliberately absent from the bag built below",
      args: emptySchema,
      returns: emptySchema,
      async run({ env }) {
        void env;
        return {};
      },
    });
    const composite = defineStep({
      description: "calls a part whose fixture needs the caller's own bag doesn't cover",
      args: emptySchema,
      returns: emptySchema,
      parts: [part],
      async run({ call }) {
        return call(part, {});
      },
    });

    const { ctx, beginStepRun } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    // Deliberately built without "env": only "call" is named, the same
    // bag composite.run's own destructuring actually needs.
    const fixtures = await buildStepFixtures(ctx, ["call"]);
    beginStepRun(composite, fixtures);

    await expect(composite.run(fixtures, {})).rejects.toThrow(/needed fixture "env"/);
  });
});

describe("ctx.call: reporting a part's own run() outcome", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("rethrows and records a failed CallEntry when the part's own run() throws", async () => {
    const part = defineStep({
      description: "always throws",
      args: emptySchema,
      returns: emptySchema,
      async run() {
        throw new Error("boom");
      },
    });
    const composite = defineStep({
      description: "calls the throwing part",
      args: emptySchema,
      returns: emptySchema,
      parts: [part],
      async run({ call }) {
        return call(part, {});
      },
    });

    const { ctx, beginStepRun, callsSnapshot } = createStepContext({
      config: baseConfig(),
      evidenceDir,
      env: {},
    });
    const fixtures = await buildStepFixtures(ctx, ["call"]);
    beginStepRun(composite, fixtures);

    await expect(composite.run(fixtures, {})).rejects.toThrow("boom");
    const calls = callsSnapshot();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.result).toBeUndefined();
    expect(calls[0]?.error).toMatchObject({ kind: "step_error", message: "boom" });
  });

  it("throws 'returns validation failed' and records it, when the part's own result fails its own returns schema", async () => {
    const part = defineStep({
      description: "returns a shape its own schema rejects",
      args: emptySchema,
      returns: z.object({ ok: z.boolean() }),
      async run() {
        return { ok: "not-a-boolean" } as unknown as { ok: boolean };
      },
    });
    const composite = defineStep({
      description: "calls the part with the bad result",
      args: emptySchema,
      returns: emptySchema,
      parts: [part],
      async run({ call }) {
        await call(part, {});
        return {};
      },
    });

    const { ctx, beginStepRun, callsSnapshot } = createStepContext({
      config: baseConfig(),
      evidenceDir,
      env: {},
    });
    const fixtures = await buildStepFixtures(ctx, ["call"]);
    beginStepRun(composite, fixtures);

    await expect(composite.run(fixtures, {})).rejects.toThrow(/returns validation failed/);
    const calls = callsSnapshot();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.error?.kind).toBe("result_invalid");
  });
});

describe("ctx.call: strict args validation", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  // A part is registered vocabulary too, publishing the same
  // `additionalProperties: false` contract `nuka describe` gives a whole
  // step (src/step/strict-args.ts's own header) — `ctx.call` used to call
  // `part.args.safeParse` directly, which strips an unrecognized key
  // instead of refusing it, so a part was the one place that contract went
  // unenforced.
  it("rejects an extra key the part's own args schema does not declare, naming it, and records the failure raw under calls[0]", async () => {
    const part = defineStep({
      description: "requires exactly one declared key",
      args: z.object({ email: z.string() }),
      returns: z.object({ email: z.string() }),
      async run({}, args) {
        return { email: args.email };
      },
    });
    const composite = defineStep({
      description: "calls the part with an extra key its args schema does not declare",
      args: emptySchema,
      returns: emptySchema,
      parts: [part],
      async run({ call }) {
        // @ts-expect-error deliberately an extra key `part.args` does not declare
        await call(part, { email: "a@example.com", EXTRA: "should be rejected" });
        return {};
      },
    });

    const { ctx, beginStepRun, callsSnapshot } = createStepContext({
      config: baseConfig(),
      evidenceDir,
      env: {},
    });
    const fixtures = await buildStepFixtures(ctx, ["call"]);
    beginStepRun(composite, fixtures);

    await expect(composite.run(fixtures, {})).rejects.toThrow(/args validation failed.*EXTRA/s);
    const calls = callsSnapshot();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.error?.kind).toBe("args_invalid");
    // `CallEntry.args` stays the raw value given to `call()`, on a
    // rejection the same as on a success (this file's own "reporting a
    // part's own run() outcome" describe block, above, covers the success
    // side) — strictArgsSchema changes what gets accepted, not what a
    // failed `CallEntry` records.
    expect(calls[0]?.args).toEqual({ email: "a@example.com", EXTRA: "should be rejected" });
  });

  it("still accepts the same call with only the declared key", async () => {
    const part = defineStep({
      description: "requires exactly one declared key",
      args: z.object({ email: z.string() }),
      returns: z.object({ email: z.string() }),
      async run({}, args) {
        return { email: args.email };
      },
    });
    const composite = defineStep({
      description: "calls the part with only the declared key",
      args: emptySchema,
      returns: z.object({ email: z.string() }),
      parts: [part],
      async run({ call }) {
        return call(part, { email: "a@example.com" });
      },
    });

    const { ctx, beginStepRun, callsSnapshot } = createStepContext({
      config: baseConfig(),
      evidenceDir,
      env: {},
    });
    const fixtures = await buildStepFixtures(ctx, ["call"]);
    beginStepRun(composite, fixtures);

    await expect(composite.run(fixtures, {})).resolves.toEqual({ email: "a@example.com" });
    const calls = callsSnapshot();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ email: "a@example.com" });
  });
});

describe("buildStepFixtures: internal invariant", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("throws loudly for a fixture name outside its own known set, rather than building an incomplete bag silently", async () => {
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });

    await expect(buildStepFixtures(ctx, ["not-a-real-fixture"])).rejects.toThrow(
      /unknown fixture name "not-a-real-fixture"/,
    );
  });
});
