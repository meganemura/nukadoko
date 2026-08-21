import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: pin down the two failure modes docs/spec.md "The second
// door: a Playwright Test suite" promises are both caught rather than
// silent, neither of which had a test before this file. Assertions target
// what a reader would act on (finding code, and which file/step names get
// named) rather than exact message wording, so a copyedit to either
// message never breaks these.
//
// tests/fixtures/check-second-door-spec-in-features-dir-project has one
// file, features/cart.spec.ts, that calls playwright/test's own test()
// (measured directly: this throws "Playwright Test did not expect test()
// to be called here" when imported outside Playwright's own runner,
// exactly the failure discovery hits when it imports every .ts file under
// featuresDir the same way it imports a step file).
//
// tests/fixtures/check-second-door-step-named-like-spec-project has two
// step files sharing one pattern ("the cart is opened"): open-cart.ts
// (step name "open-cart") and open-cart.spec.ts (step name
// "open-cart.spec", since a step's name is its file's basename). Its
// features/cart.feature scenario uses that exact step text, which both
// step names match.

describe("nuka check: the Playwright Test door's two failure modes", () => {
  it("names a spec file placed inside featuresDir as step-file-import-failed", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-second-door-spec-in-features-dir-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; file?: string; message: string }>;
    };
    const importFailure = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(importFailure).toBeDefined();
    expect(importFailure?.file).toBe("features/cart.spec.ts");
    // Playwright's own refusal message, passed through verbatim by
    // discovery (src/discover/discover-steps.ts) rather than re-classified.
    // Checked for the fact it names (test() called outside its runner),
    // not for its exact wording.
    expect(importFailure?.message).toContain("test()");
    expect(exitCode).toBe(1);
  });

  it("names a step file named like a spec as ambiguous-step, alongside the step it collides with", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-second-door-step-named-like-spec-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; file?: string; message: string }>;
    };
    const ambiguous = report.errors.find((issue) => issue.code === "ambiguous-step");
    expect(ambiguous).toBeDefined();
    expect(ambiguous?.file).toBe("features/cart.feature");
    // Both step names the shared pattern resolves to, named in the same
    // finding: the fix docs/spec.md points at (the file name) only makes
    // sense once a reader can see both sides of the collision. "open-cart"
    // is a prefix of "open-cart.spec", so a bare substring check for the
    // shorter name would still pass if only the spec-named step were
    // listed; the lookahead below requires an "open-cart" occurrence that
    // is not the start of "open-cart.spec", which only the first step's
    // own name can be.
    expect(ambiguous?.message).toMatch(/open-cart(?!\.spec)/);
    expect(ambiguous?.message).toContain("open-cart.spec");
    expect(exitCode).toBe(1);
  });
});
