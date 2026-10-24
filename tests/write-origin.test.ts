import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { type Layer, layerOfModule, verdictOf, writeMadeByPlaywrightServer } from "../src/context/write-origin.js";

// Responsibility: who made a file write, from its call stack
// (src/context/write-origin.ts). The properties: the first frame that is
// not one of Playwright's shared helpers decides, a frame outside
// Playwright decides for the step, and a stack of helpers alone is
// Playwright's. The examples: where each of Playwright's source modules
// sits, and a write from the test's own code.

const helpers = gs.arrays(gs.just<Layer>("helper"), { maxSize: 4 });
const anyFrame = gs.sampledFrom<Layer | undefined>(["client", "dispatcher", "server", "helper", undefined]);
const rest = gs.arrays(anyFrame, { maxSize: 4 });

describe("verdictOf", () => {
  it("is decided by the first frame that is not a shared helper, whatever follows it", () =>
    hegel.test((tc) => {
      const deciding = tc.draw(gs.sampledFrom<Layer | undefined>(["client", "dispatcher", "server", undefined]));
      const layers = [...tc.draw(helpers), deciding, ...tc.draw(rest)];
      expect(verdictOf(layers)).toBe(deciding === "server" ? "server" : "step");
    }));

  it("gives a stack of shared helpers alone to Playwright, and an empty one to nobody", () =>
    hegel.test((tc) => {
      const layers = tc.draw(helpers);
      expect(verdictOf(layers)).toBe(layers.length === 0 ? "no frame" : "helpers only");
    }));
});

describe("layerOfModule", () => {
  it("places each of Playwright's source modules, bundled or not", () => {
    expect(
      [
        "packages/playwright-core/src/client/page.ts",
        "client/page.js",
        "packages/playwright-core/src/server/dispatchers/artifactDispatcher.ts",
        "packages/playwright-core/src/server/localUtils.ts",
        "server/localUtils.js",
        "packages/playwright-core/src/server/trace/recorder/tracing.ts",
        "server/har/harRecorder.js",
        "packages/utils/serializedFS.ts",
        "packages/playwright-core/src/utils/isomorphic/manualPromise.ts",
        "node_modules/yazl/index.js",
      ].map(layerOfModule),
    ).toEqual(["client", "client", "dispatcher", "dispatcher", "dispatcher", "server", "server", "helper", "helper", "helper"]);
  });
});

describe("writeMadeByPlaywrightServer", () => {
  it("gives a write the test's own code makes to the step", () => {
    expect(writeMadeByPlaywrightServer()).toBe(false);
  });
});
