import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Vitest's own 5s default is not a realistic budget for this suite:
    // several files launch a real chromium (browser-evidence, session-
    // browser, run-browser) and one spawns the CLI as a subprocess (skill),
    // and vitest runs files in parallel — so a full run can have several
    // browsers starting at once on a machine that is already busy. Those
    // tests take 100-600ms each when run alone; the failures only ever
    // appear under full-suite parallel load, always in a different file,
    // and always pass on their own. That is contention, not a hang, and 5s
    // is what makes contention look like a hang.
    //
    // The specific number matters, and 20s was the wrong one: Playwright's
    // own default navigation timeout is 30s, so a `page.goto` stuck under
    // load was being cut off by vitest at 20s — before Playwright could
    // raise the error that says which navigation hung and why. Whatever
    // this is set to has to sit above Playwright's own timeouts, or the
    // suite reports "Test timed out" where it could have reported the
    // actual failure.
    testTimeout: 60_000,
  },
});
