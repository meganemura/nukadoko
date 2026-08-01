import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";

// Whether to run at all: computed once at module load (top-level await), so
// `it.skipIf` below sees the real answer instead of the pre-`beforeAll`
// default a hook-based check would leave it at during test collection. Per
// the task spec: chromium is expected to already be installed
// (`npx playwright install chromium`); this is only a safety net for an
// environment where that step is genuinely impossible.
async function isChromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = await isChromiumAvailable();

function baseConfig(overrides: Partial<NukadokoConfig> = {}): NukadokoConfig {
  return {
    featuresDir: "features",
    stateDir: ".nukadoko",
    envFiles: [],
    ...overrides,
  };
}

describe("createStepContext / ctx.page()", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-browser-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it.skipIf(!chromiumAvailable)(
    "launches chromium, traces the run, and saves a final screenshot",
    async () => {
      const { ctx, dispose } = createStepContext({
        rootDir: evidenceDir,
        config: baseConfig(),
        evidenceDir,
      });

      const page = await ctx.page();
      await page.setContent("<html><body>hello</body></html>");

      const { evidence, storageState } = await dispose("ok");

      expect(evidence.trace).toBe("trace.zip");
      expect(evidence.screenshots).toEqual(["final.png"]);
      expect(existsSync(path.join(evidenceDir, "trace.zip"))).toBe(true);
      expect(existsSync(path.join(evidenceDir, "final.png"))).toBe(true);
      // A browser context was opened, so there is always something to
      // persist for a session, even one with no cookies yet (this task's
      // spec, decision 2).
      expect(storageState).toBeDefined();
    },
  );

  it.skipIf(!chromiumAvailable)(
    "additionally saves failure.png when the execution failed",
    async () => {
      const { ctx, dispose } = createStepContext({
        rootDir: evidenceDir,
        config: baseConfig(),
        evidenceDir,
      });

      const page = await ctx.page();
      await page.setContent("<html><body>hello</body></html>");

      const { evidence } = await dispose("failed");

      expect(evidence.screenshots.sort()).toEqual(["failure.png", "final.png"]);
      expect(existsSync(path.join(evidenceDir, "failure.png"))).toBe(true);
    },
  );

  it.skipIf(!chromiumAvailable)(
    "still resolves dispose() with only real files listed when the step closed the browser itself before throwing",
    async () => {
      // A step's `run` reaches the browser through `ctx.page()`
      // (`page.context().browser()`), so it can close it (or it can crash)
      // before throwing. `runDo` (src/cli/do.ts) always calls dispose() on
      // its way to writing the receipt regardless of how `run` ended, so
      // dispose() must never throw here — screenshot/tracing.stop/
      // context.close/browser.close teardown failures are all swallowed
      // (browser-evidence.ts's finalize), and evidence only claims trace.zip
      // when tracing.stop actually got to write it (create-context.ts's
      // dispose).
      const { ctx, dispose } = createStepContext({
        rootDir: evidenceDir,
        config: baseConfig(),
        evidenceDir,
      });

      const page = await ctx.page();
      await page.context().browser()?.close();

      const { evidence, storageState } = await dispose("failed");

      expect(evidence.screenshots).toEqual([]);
      expect(evidence.trace).toBeUndefined();
      expect(existsSync(path.join(evidenceDir, "trace.zip"))).toBe(false);
      expect(existsSync(path.join(evidenceDir, "final.png"))).toBe(false);
      // The context was already closed, so collectStorageState() must have
      // swallowed its own failure the same way finalize()'s teardown does.
      expect(storageState).toBeUndefined();
    },
  );

  if (!chromiumAvailable) {
    // Surfaced in the implementer's report, per the task spec: only skip
    // when chromium is genuinely unavailable in this environment.
    console.warn(
      "browser-evidence.test.ts: chromium unavailable, browser-path tests skipped",
    );
  }
});
