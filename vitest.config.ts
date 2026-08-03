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
    testTimeout: 20_000,
  },
});
