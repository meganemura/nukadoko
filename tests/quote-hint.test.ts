import { describe, expect, it } from "vitest";
import { quoteGapCandidates } from "../src/binding/quote-hint.js";

describe("quote hint", () => {
  it("stays silent when the candidate search reaches its limit", () => {
    expect(quoteGapCandidates("a".repeat(50), ["", "a", "a", "a", ""])).toEqual([]);
  });
});
