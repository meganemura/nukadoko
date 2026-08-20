import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Vitest sizes its worker pool from the core count, which is the wrong
    // measure for this suite: three files launch a real chromium
    // (browser-evidence, session-browser, run-browser) and one spawns the
    // CLI as a subprocess (skill), so the cost of a worker here is a
    // browser and its renderer processes, not a thread. Left unbounded on a
    // 10-core machine, those files land on separate workers simultaneously
    // and contend for CPU with everything else already running — which is
    // what made real navigations stall for tens of seconds and read as
    // hangs. Capping the pool costs a few seconds of wall clock and removes
    // the contention rather than widening a timeout to tolerate it.
    //
    // Spelled `maxWorkers` rather than `poolOptions.forks.maxForks`: Vitest 4
    // moved the pool sizing knobs to the top level and *ignores* the old
    // nested form, warning about it instead of failing. That is a cap which
    // silently stops capping — the suite still goes green on an idle machine,
    // and the contention it was there to prevent only comes back under load.
    maxWorkers: 4,
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
    // Hooks get the same budget as tests, for the same reason. Vitest's
    // own default is 10s, and several fixtures spawn `git init` from a
    // `beforeEach`; under a loaded machine that spawn exceeds 10s and the
    // file fails with a hook timeout that has nothing to do with what it
    // was testing. Three separate runs hit exactly that on the same three
    // sign-off files while other work was running alongside, and all three
    // passed standalone straight afterwards. Leaving the test budget at
    // 60s while the hook budget stays at 10s means contention keeps
    // arriving as a failure in whichever file happens to be unlucky.
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      // Only `src/`. That is what the npm tarball ships and what a user's
      // own code reaches; `examples/` is documentation that is not even
      // packaged (see package.json's `files`), `selftest-suite/` is itself
      // a harness rather than a thing under test, and counting either one
      // moves the number without saying anything about the library. A
      // coverage figure that includes an example server is a figure nobody
      // can act on.
      include: ["src/**/*.ts"],
      // `include` alone still lets a loaded file outside it be reported,
      // so the two example/harness trees are named here as well.
      //
      // The three named files after them are process entry points, where
      // importing the module *is* running it: `cli.ts` is the installed
      // bin, `daemon-entry.ts` starts a live session's daemon, and
      // `define-config.ts` is an identity helper that exists to give a
      // config literal a type and deliberately validates nothing. A test
      // that reached any of them would start a process or assert that an
      // identity function returns its argument, so their absence from the
      // report is a fact about their shape rather than a gap in the suite.
      // Nothing else is excluded on grounds of being hard to reach: an
      // experimental command is still ordinary code and stays counted.
      exclude: [
        "examples/**",
        "selftest-suite/**",
        "tests/**",
        "src/cli.ts",
        "src/live/daemon-entry.ts",
        "src/config/define-config.ts",
      ],
      reporter: ["text-summary", "json-summary"],
    },
  },
});
