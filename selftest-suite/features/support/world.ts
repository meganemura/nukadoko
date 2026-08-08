import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { setWorldConstructor, World } from "../steps/runtime.js";

// Holds the state this suite's steps pass between each other: the outcome
// of the `nuka run` subprocess the When step spawns against the INNER
// fixture project (selftest-suite/fixture-project, see run-selftest.mjs's
// header comment for the inner/outer distinction), and, for the
// @allure-report and @allure-watch scenarios, the HTTP server (or `allure
// watch` process) and browser their own steps and hooks own.
// selftest-allure task spec, decision 1: the suite stays vanilla
// cucumber-js, World plus Playwright plus a cucumber-js Before/After hook,
// nothing more. No constructor override: the base World's single-argument
// constructor is inherited as-is, same as
// tests/fixtures/compat-world-project's CustomWorld.
export class SelftestWorld extends World {
  nukaExitCode: number | null = null;
  nukaStdout = "";
  // The next four are null/empty outside the @allure-report scenario: its
  // own Before hook is the only place any of them is ever assigned.
  httpServer: ChildProcess | null = null;
  reportUrl = "";
  // Shared with @allure-watch (features/steps/allure-watch.ts): every
  // scenario gets a brand new World instance, so reusing these two rather
  // than adding a second browser/page pair costs nothing and there is no
  // cross-scenario leakage to worry about.
  browser: Browser | null = null;
  page: Page | null = null;
  // The rest are null/empty outside the @allure-watch scenario
  // (features/steps/allure-watch.ts): `allure watch`'s own subprocess and
  // the URL it printed, the fixture project's `nuka run` subprocess spawned
  // without being awaited, that subprocess's own eventual result (never a
  // rejecting promise -- see allure-watch.ts's own comment on why), and the
  // one count read back from the report while that subprocess was still
  // running, which is this whole scenario's reason to exist.
  watchProcess: ChildProcess | null = null;
  watchBaseUrl = "";
  runProcess: ChildProcess | null = null;
  runCompletion: Promise<{ code: number; stdout: string; stderr: string }> | null = null;
  midRunResultCount: number | null = null;
}

setWorldConstructor(SelftestWorld);
