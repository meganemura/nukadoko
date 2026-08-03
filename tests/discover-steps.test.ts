import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSteps, type VocabularyEntry } from "../src/discover/discover-steps.js";
import { DuplicateStepError } from "../src/discover/errors.js";
import { fixture } from "./helpers/fixtures.js";

/** Narrows a vocabulary lookup to its "typed" branch for tests that only
 * ever deal with typed fixtures — throws (rather than silently returning
 * `undefined`) so a mistaken lookup fails loudly instead of producing a
 * confusing "Cannot read properties of undefined" a level up. */
function asTyped(entry: VocabularyEntry | undefined) {
  if (entry?.kind !== "typed") {
    throw new Error(`expected a typed vocabulary entry, got: ${JSON.stringify(entry)}`);
  }
  return entry;
}

describe("discoverSteps", () => {
  it("finds typed steps under featuresDir and skips non-step default exports", async () => {
    const { vocabulary } = await discoverSteps(fixture("basic-project"), "features");
    expect([...vocabulary.keys()].sort()).toEqual([
      "create-project",
      "get-project",
      "list-projects",
    ]);
    expect(vocabulary.has("format-id")).toBe(false);
  });

  it("names a step after its file name and preserves its contract", async () => {
    const { vocabulary } = await discoverSteps(fixture("basic-project"), "features");
    const entry = asTyped(vocabulary.get("create-project"));
    expect(entry.step.patterns).toEqual(["a project {string} exists"]);
    expect(entry.step.description).toBe("Create a project and return its id");
    expect(entry.step.mutates).toBe(true);
  });

  it("supports a step with no pattern (CLI-only vocabulary)", async () => {
    const { vocabulary } = await discoverSteps(fixture("basic-project"), "features");
    const entry = asTyped(vocabulary.get("list-projects"));
    expect(entry.step.patterns).toEqual([]);
    expect(entry.step.mutates).toBe(false);
  });

  it("honors a custom featuresDir", async () => {
    const { vocabulary } = await discoverSteps(fixture("custom-config-project"), "bdd");
    expect([...vocabulary.keys()]).toEqual(["noop"]);
  });

  it("throws DuplicateStepError when two files share a step name", async () => {
    await expect(
      discoverSteps(fixture("duplicate-steps-project"), "features"),
    ).rejects.toBeInstanceOf(DuplicateStepError);
  });

  it("returns an empty vocabulary when featuresDir does not exist", async () => {
    const { vocabulary, compatParameterTypes } = await discoverSteps(
      fixture("basic-project"),
      "does-not-exist",
    );
    expect(vocabulary.size).toBe(0);
    expect(compatParameterTypes).toEqual([]);
  });

  // Module identity (m2pre-module-identity task spec): discoverSteps() loads
  // every file through one shared tsx module registration for the whole
  // discovery run, so a step file's own relative import of another step
  // file resolves to the exact same object discoverSteps() itself put in
  // the vocabulary — not a second, independent load. tests/fixtures/
  // module-identity-project/features/steps/consumer.ts's own relative
  // import of producer.ts stashes what it got on `globalThis` (the only
  // channel that crosses tsx's per-namespace module cache from outside;
  // see that file's own comment) so this test can compare it against
  // discoverSteps()'s vocabulary entry for producer.ts by `===`.
  it("gives the same Step object via the vocabulary and via another step file's relative import", async () => {
    const captureKey = "__nukadokoModuleIdentityTestCapture";
    const globalCapture = globalThis as Record<string, unknown>;
    delete globalCapture[captureKey];

    const { vocabulary } = await discoverSteps(fixture("module-identity-project"), "features");
    const capturedViaRelativeImport = globalCapture[captureKey];
    delete globalCapture[captureKey];

    expect(capturedViaRelativeImport).toBeDefined();
    expect(capturedViaRelativeImport).toBe(asTyped(vocabulary.get("producer")).step);
  });
});

// m21a-compat-gap-detect task spec: `{ tolerateImportFailures: true }` lets
// discovery survive a broken glue file instead of rejecting the whole call
// — the mode `nuka check` (src/check/analyze.ts) uses so one broken file
// doesn't take down the entire report the way it still does for
// `run`/`do`/`steps`/`init`.
describe("discoverSteps: tolerant mode (m21a-compat-gap-detect)", () => {
  it("collects a broken file's import failure and still discovers a sibling healthy file", async () => {
    const { vocabulary, importFailures } = await discoverSteps(
      fixture("discover-import-failure-project"),
      "features",
      { tolerateImportFailures: true },
    );

    expect(importFailures).toHaveLength(1);
    expect(importFailures[0]?.filePath).toBe(path.join("features", "steps", "broken.ts"));
    expect(importFailures[0]?.message).toContain("require is not defined");

    expect([...vocabulary.keys()]).toEqual(["healthy"]);
  });

  it("default mode (no options) still rejects on the first broken file, unchanged", async () => {
    await expect(
      discoverSteps(fixture("discover-import-failure-project"), "features"),
    ).rejects.toThrow(/require is not defined/);
  });

  it("does not let a file that dies partway through its own evaluation leak its registration into the next file (decision 3)", async () => {
    const { vocabulary, importFailures } = await discoverSteps(
      fixture("discover-partial-eval-failure-project"),
      "features",
      { tolerateImportFailures: true },
    );

    expect(importFailures).toHaveLength(1);
    expect(importFailures[0]?.message).toContain("boom");

    // The registration a-partial-eval-failure.ts made before it threw must
    // be discarded entirely, not attributed to b-next-file.ts.
    expect(vocabulary.has("compat: registered before the failure")).toBe(false);
    expect(vocabulary.has("compat: registered by the next file")).toBe(true);
  });

  it("still throws DuplicateStepError in tolerant mode (decision 2: duplicates are not import failures)", async () => {
    await expect(
      discoverSteps(fixture("duplicate-steps-project"), "features", {
        tolerateImportFailures: true,
      }),
    ).rejects.toBeInstanceOf(DuplicateStepError);
  });
});
