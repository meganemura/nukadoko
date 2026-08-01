import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// Responsibility: the Playwright side of evidence collection when a step
// calls `ctx.page()` — launch chromium, trace the whole browser context,
// and capture screenshot(s) at the end — kept separate from
// context/create-context.ts so that module isn't also responsible for
// Playwright's specific launch/newContext/tracing/newPage lifecycle and its
// mirrored teardown. `finalize` is never reachable from a step's `run`: only
// create-context.ts's `dispose` (executor-only) calls it, after `run` has
// already returned or thrown.

export interface LaunchBrowserOptions {
  /** Maps to `config.browser.headless`, default true. */
  headless: boolean;
  /** Where trace.zip and screenshot(s) are written. Must already exist. */
  evidenceDir: string;
}

export interface BrowserEvidenceHandle {
  readonly page: Page;
  /** Stops tracing, saves trace.zip, captures screenshot(s), and closes the
   * browser. Returns the screenshot file names actually written (best
   * effort: a screenshot failure here must never mask the step's real
   * outcome, so it is swallowed rather than thrown). */
  finalize(status: "ok" | "failed"): Promise<string[]>;
}

export async function launchBrowserWithTracing(
  options: LaunchBrowserOptions,
): Promise<BrowserEvidenceHandle> {
  const browser: Browser = await chromium.launch({ headless: options.headless });
  const context: BrowserContext = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();

  async function finalize(status: "ok" | "failed"): Promise<string[]> {
    const screenshots: string[] = [];
    try {
      const buffer = await page.screenshot();
      await writeFile(path.join(options.evidenceDir, "final.png"), buffer);
      screenshots.push("final.png");
      // "final.png" is always saved; on failure it is additionally saved
      // again as "failure.png" so a failed receipt's evidence is easy to
      // spot without opening every screenshot to find the relevant one.
      if (status === "failed") {
        await writeFile(path.join(options.evidenceDir, "failure.png"), buffer);
        screenshots.push("failure.png");
      }
    } catch {
      // The page may already be closed or otherwise unusable after a failed
      // run; losing a screenshot is not a reason to also lose the receipt.
    }
    // Same reasoning for the three teardown calls below: a step can reach
    // the browser via ctx.page() and close (or crash) it before throwing, so
    // tracing.stop/context.close/browser.close can each fail on an already-
    // gone context/browser. A missing trace.zip or a browser left half-torn-
    // down is not a reason to also lose the receipt, so each is swallowed
    // independently and best-effort teardown continues.
    try {
      await context.tracing.stop({ path: path.join(options.evidenceDir, "trace.zip") });
    } catch {
      // See comment above.
    }
    try {
      await context.close();
    } catch {
      // See comment above.
    }
    try {
      await browser.close();
    } catch {
      // See comment above.
    }
    return screenshots;
  }

  return { page, finalize };
}
