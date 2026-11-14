import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  declaresDoneCallback,
  passedArgCountForStep,
  RUN_HOOK_ARG_COUNT,
  SCENARIO_HOOK_ARG_COUNT,
} from "../src/check/done-callback.js";

// Responsibility: the done() signal is one comparison, shared by a scenario
// hook (one argument), a run-scope hook (zero), and a matched step (captures
// plus a table or docstring). The property is that those three call shapes
// are that comparison, and that an attachment can only remove the signal.

const nonNegative = gs.integers({ minValue: 0, maxValue: 32 });

describe("declaresDoneCallback", () => {
  it("is strict greater-than for every non-negative pair", () =>
    hegel.test((tc) => {
      const declared = tc.draw(nonNegative);
      const passed = tc.draw(nonNegative);
      expect(declaresDoneCallback(declared, passed)).toBe(declared > passed);
    }));

  it("matches the executor's hook limits", () =>
    hegel.test((tc) => {
      const declared = tc.draw(nonNegative);
      expect(declaresDoneCallback(declared, SCENARIO_HOOK_ARG_COUNT)).toBe(declared >= 2);
      expect(declaresDoneCallback(declared, RUN_HOOK_ARG_COUNT)).toBe(declared >= 1);
    }));

  it("treats equal arity as a real parameter list, not a done() callback", () =>
    hegel.test((tc) => {
      const declared = tc.draw(nonNegative);
      expect(declaresDoneCallback(declared, declared)).toBe(false);
    }));

  it("counts a table or docstring as exactly one extra argument", () =>
    hegel.test((tc) => {
      const captures = tc.draw(nonNegative);
      expect(passedArgCountForStep(captures, false)).toBe(captures);
      expect(passedArgCountForStep(captures, true)).toBe(captures + 1);
    }));

  it("lets an attachment only clear a done() signal, never create one", () =>
    hegel.test((tc) => {
      const declared = tc.draw(nonNegative);
      const captures = tc.draw(nonNegative);
      const withAttachment = declaresDoneCallback(declared, passedArgCountForStep(captures, true));
      const withoutAttachment = declaresDoneCallback(declared, passedArgCountForStep(captures, false));
      if (withAttachment) {
        expect(withoutAttachment).toBe(true);
      }
    }));
});
