import { describe, expect, it } from "vitest";
import { discoverSteps } from "../src/discover/discover-steps.js";
import { DuplicateStepError } from "../src/discover/errors.js";
import { fixture } from "./helpers/fixtures.js";

describe("discoverSteps", () => {
  it("finds typed steps under featuresDir and skips non-step default exports", async () => {
    const vocabulary = await discoverSteps(fixture("basic-project"), "features");
    expect([...vocabulary.keys()].sort()).toEqual([
      "create-project",
      "get-project",
      "list-projects",
    ]);
    expect(vocabulary.has("format-id")).toBe(false);
  });

  it("names a step after its file name and preserves its contract", async () => {
    const vocabulary = await discoverSteps(fixture("basic-project"), "features");
    const entry = vocabulary.get("create-project");
    expect(entry?.step.patterns).toEqual(["a project {string} exists"]);
    expect(entry?.step.description).toBe("Create a project and return its id");
    expect(entry?.step.mutates).toBe(true);
  });

  it("supports a step with no pattern (CLI-only vocabulary)", async () => {
    const vocabulary = await discoverSteps(fixture("basic-project"), "features");
    const entry = vocabulary.get("list-projects");
    expect(entry?.step.patterns).toEqual([]);
    expect(entry?.step.mutates).toBe(false);
  });

  it("honors a custom featuresDir", async () => {
    const vocabulary = await discoverSteps(fixture("custom-config-project"), "bdd");
    expect([...vocabulary.keys()]).toEqual(["noop"]);
  });

  it("throws DuplicateStepError when two files share a step name", async () => {
    await expect(
      discoverSteps(fixture("duplicate-steps-project"), "features"),
    ).rejects.toBeInstanceOf(DuplicateStepError);
  });

  it("returns an empty vocabulary when featuresDir does not exist", async () => {
    const vocabulary = await discoverSteps(fixture("basic-project"), "does-not-exist");
    expect(vocabulary.size).toBe(0);
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

    const vocabulary = await discoverSteps(fixture("module-identity-project"), "features");
    const capturedViaRelativeImport = globalCapture[captureKey];
    delete globalCapture[captureKey];

    expect(capturedViaRelativeImport).toBeDefined();
    expect(capturedViaRelativeImport).toBe(vocabulary.get("producer")?.step);
  });
});
