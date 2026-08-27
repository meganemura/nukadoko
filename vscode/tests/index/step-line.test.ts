import { describe, expect, it } from "vitest";
import { parseStepLine } from "../../src/index/step-line.js";

describe("parseStepLine", () => {
  it.each([
    ["Given a todo titled \"Buy milk\" is added", "a todo titled \"Buy milk\" is added"],
    ["When the widgets are counted", "the widgets are counted"],
    ["Then there are 3 widgets left", "there are 3 widgets left"],
    ["And another step follows", "another step follows"],
    ["But this one does not", "this one does not"],
    ["* a wildcard step keyword", "a wildcard step keyword"],
    ["    Given indentation is trimmed", "indentation is trimmed"],
  ])("strips the keyword from %j", (lineText, expected) => {
    expect(parseStepLine(lineText)).toBe(expected);
  });

  it.each([
    ["Feature: a feature title"],
    ["Scenario: a scenario title"],
    ["Background:"],
    ["# a comment line"],
    ["| a | table | row |"],
    ["\"\"\""],
    [""],
    ["   "],
    ["GivenSomethingElse without a space"],
    ["Given"],
    ["Given   "],
  ])("returns undefined for %j", (lineText) => {
    expect(parseStepLine(lineText)).toBeUndefined();
  });
});
