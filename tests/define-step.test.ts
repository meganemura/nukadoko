import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStep, isStep } from "../src/step/define-step.js";

describe("defineStep", () => {
  it("brands its return value so discovery can recognize it", () => {
    const step = defineStep({
      pattern: "a thing happens",
      description: "does a thing",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(isStep(step)).toBe(true);
  });

  it("defaults mutates to true", () => {
    const step = defineStep({
      description: "no explicit mutates",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.mutates).toBe(true);
  });

  it("honors an explicit mutates: false", () => {
    const step = defineStep({
      description: "read-only",
      args: z.object({}),
      returns: z.object({}),
      mutates: false,
      async run() {
        return {};
      },
    });
    expect(step.mutates).toBe(false);
  });

  it("wraps a single pattern into patterns", () => {
    const step = defineStep({
      pattern: "one pattern",
      description: "d",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.patterns).toEqual(["one pattern"]);
  });

  it("combines pattern and patterns, pattern first", () => {
    const step = defineStep({
      pattern: "primary",
      patterns: ["alias one", "alias two"],
      description: "d",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.patterns).toEqual(["primary", "alias one", "alias two"]);
  });

  it("allows omitting patterns entirely for CLI-only vocabulary", () => {
    const step = defineStep({
      description: "cli only",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.patterns).toEqual([]);
  });

  it("carries an explicit rationale onto Step.rationale", () => {
    const step = defineStep({
      description: "does a thing",
      rationale: "chose X over Y because Y rejects malformed input",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.rationale).toBe("chose X over Y because Y rejects malformed input");
  });

  it("leaves rationale undefined when omitted (no default)", () => {
    const step = defineStep({
      description: "no explicit rationale",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    });
    expect(step.rationale).toBeUndefined();
  });

  it("does not consider an arbitrary object a step", () => {
    expect(isStep({ pattern: "not a step" })).toBe(false);
    expect(isStep(undefined)).toBe(false);
    expect(isStep(null)).toBe(false);
    expect(isStep(() => undefined)).toBe(false);
  });
});
