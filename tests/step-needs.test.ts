import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStep } from "../src/step/define-step.js";
import { stepNeeds } from "../src/step/step-needs.js";

// Responsibility: unit tests for src/step/step-needs.ts's `stepNeeds` —
// the pure function `nuka steps --json`'s `needs`/
// `needs_browser` fields go through, exercised directly (no CLI, no
// discovery) so the alphabetizing and the `page`/`context` membership check
// are each pinned down in isolation. tests/from-chain.test.ts and this
// file's own CLI-level counterpart cover the same fields end to end through
// `nuka steps --json`.

const emptySchema = z.object({});

describe("stepNeeds", () => {
  it("returns needs: [] and needsBrowser: false for a step that destructures no fixtures", () => {
    const step = defineStep({
      description: "no fixtures",
      args: emptySchema,
      returns: emptySchema,
      run() {
        return {};
      },
    });
    expect(stepNeeds(step)).toEqual({ needs: [], needsBrowser: false });
  });

  it("returns needs: [] and needsBrowser: false for a step whose run() takes no arguments", () => {
    const step = defineStep({
      description: "no arguments",
      args: emptySchema,
      returns: emptySchema,
      run: () => ({}),
    });
    expect(stepNeeds(step)).toEqual({ needs: [], needsBrowser: false });
  });

  it("alphabetizes needs regardless of the order destructured in source", () => {
    const step = defineStep({
      description: "out of order",
      args: emptySchema,
      returns: emptySchema,
      async run({ section, baseURL }) {
        void section;
        void baseURL;
        return {};
      },
    });
    expect(stepNeeds(step).needs).toEqual(["baseURL", "section"]);
  });

  it("sets needsBrowser true when page is destructured", () => {
    const step = defineStep({
      description: "page",
      args: emptySchema,
      returns: emptySchema,
      async run({ page }) {
        void page;
        return {};
      },
    });
    expect(stepNeeds(step)).toEqual({ needs: ["page"], needsBrowser: true });
  });

  it("sets needsBrowser true when context is destructured", () => {
    const step = defineStep({
      description: "context",
      args: emptySchema,
      returns: emptySchema,
      async run({ context }) {
        void context;
        return {};
      },
    });
    expect(stepNeeds(step)).toEqual({ needs: ["context"], needsBrowser: true });
  });

  it("sets needsBrowser false for a step that needs fixtures but never page or context", () => {
    const step = defineStep({
      description: "request only",
      args: emptySchema,
      returns: emptySchema,
      async run({ request, env }) {
        void request;
        void env;
        return {};
      },
    });
    expect(stepNeeds(step)).toEqual({ needs: ["env", "request"], needsBrowser: false });
  });

  it("sets needsBrowser true when only a declared part destructures page (docs/spec.md Parts)", () => {
    const part = defineStep({
      description: "a part that touches the browser",
      args: emptySchema,
      returns: emptySchema,
      async run({ page }) {
        void page;
        return {};
      },
    });
    const composite = defineStep({
      description: "never destructures page itself",
      args: emptySchema,
      returns: emptySchema,
      parts: [part],
      async run({ call }) {
        await call(part, {});
        return {};
      },
    });
    expect(stepNeeds(composite)).toEqual({ needs: ["call", "page"], needsBrowser: true });
  });
});
