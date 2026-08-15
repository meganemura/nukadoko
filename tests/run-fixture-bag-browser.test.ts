import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: proves a scenario that never names `page` never launches
// the browser — fixed by a real
// measurement, not an inference from absent trace evidence (the way
// tests/run-browser.test.ts's own "no chunk" assertion works). A
// `vi.spyOn(chromium, "launch")` (the same spy tests/browser-evidence.test.ts
// already uses to intercept a real launch) asserts the opposite here: zero
// calls for a scenario whose only step never destructures `page` at all.
// The second scenario in the same feature file — which does destructure
// `page` — is the contrast case: `launch` is called there, proving the spy
// would have caught a regression rather than passing vacuously.

interface StoredRecord {
  readonly status: string;
  readonly evidence: { readonly trace?: string; readonly screenshots: readonly unknown[] };
}

describe("nuka run: a scenario that never destructures page never launches a browser", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-browser-project");
    // No baseURL: neither step in features/no-browser.feature ever
    // navigates anywhere — the point here is bag construction, not network.
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      ['import { defineConfig } from "./nukadoko-shim.js";', "export default defineConfig({});", ""].join("\n"),
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("calls chromium.launch zero times for the page-less scenario and once for the page-naming one", async () => {
    const launchSpy = vi.spyOn(chromium, "launch");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/no-browser.feature"], { rootDir, stdout, stderr });

      expect(stripRunProgressLines(stderr.text())).toBe("");
      expect(exitCode).toBe(0);

      const records = stdout
        .text()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as StoredRecord);
      expect(records).toHaveLength(2);

      const [pageLess, pageNaming] = records;
      expect(pageLess!.status).toBe("passed");
      expect(pageNaming!.status).toBe("passed");

      // The measurement this test exists for: a browser was launched
      // exactly once, for the scenario whose step destructures `page` —
      // never for the one ahead of it, whose step's run() takes `()`.
      expect(launchSpy).toHaveBeenCalledTimes(1);

      // Same fact, read back from evidence (belt and braces, the same
      // proxy tests/run-browser.test.ts's own "no chunk" assertion uses):
      // no trace, no screenshot for the page-less scenario; both present
      // for the one that touched the browser.
      expect(pageLess!.evidence.trace).toBeUndefined();
      expect(pageLess!.evidence.screenshots).toEqual([]);
      expect(pageNaming!.evidence.screenshots).toHaveLength(1);
    } finally {
      launchSpy.mockRestore();
    }
  });
});
