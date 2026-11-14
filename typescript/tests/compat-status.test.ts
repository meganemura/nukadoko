import { describe, expect, it } from "vitest";
import { Status } from "../src/compat/index.js";

// Responsibility: `Status` is
// a plain re-export of `@cucumber/messages`'s own `TestStepResultStatus`
// (a real, string-valued enum), not a second enum this project defines
// itself, so `nuka run: HookParameter.result.status` coverage in
// tests/compat-execution.test.ts's own "HookParameter reaches every hook"
// describe block is what actually proves it works end to end against a real
// After hook; this file only proves the import itself resolves and that its
// values are what cucumber-js's own `Status.FAILED` is.
describe("nukadoko/compat: Status", () => {
  it("is importable from nukadoko/compat and Status.FAILED === \"FAILED\"", () => {
    expect(Status.FAILED).toBe("FAILED");
  });

  it("Status.PASSED === \"PASSED\" (the only other value HookParameter.result.status ever actually takes)", () => {
    expect(Status.PASSED).toBe("PASSED");
  });
});
