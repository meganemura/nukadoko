import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { hookDisplayTitle } from "../src/record/scenario-record.js";

// Responsibility: hookDisplayTitle is the one rule every surface uses when
// a stored hook name replaces a keyword. A blend ("Before (name)") would
// still look plausible in one example and be wrong on every surface.

describe("hookDisplayTitle", () => {
  it("is exactly the non-empty name, otherwise the fallback", () =>
    hegel.test((tc) => {
      const fallback = tc.draw(gs.text());
      const name = tc.draw(gs.text());
      const title = hookDisplayTitle(fallback, name);
      expect(title).toBe(name.length > 0 ? name : fallback);
      expect(title === name || title === fallback).toBe(true);
    }));

  it("keeps the fallback when the name is omitted", () =>
    hegel.test((tc) => {
      const fallback = tc.draw(gs.text());
      expect(hookDisplayTitle(fallback, undefined)).toBe(fallback);
    }));
});
