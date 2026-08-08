import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { setWorldConstructor, World } from "../steps/runtime.js";

// Holds the state this suite's steps pass between each other: the outcome
// of the `nuka run` subprocess the When step spawns against the INNER
// fixture project (selftest-suite/fixture-project, see run-selftest.mjs's
// header comment for the inner/outer distinction), and, for the
// @allure-report scenario only, the HTTP server and browser the
// allure-report.ts Before/After hooks own. selftest-allure task spec,
// decision 1: the suite stays vanilla cucumber-js, World plus Playwright
// plus a cucumber-js Before/After hook, nothing more. No constructor
// override: the base World's single-argument constructor is inherited
// as-is, same as tests/fixtures/compat-world-project's CustomWorld.
export class SelftestWorld extends World {
  nukaExitCode: number | null = null;
  nukaStdout = "";
  // The next four are null outside the @allure-report scenario: its own
  // Before hook is the only place any of them is ever assigned.
  httpServer: ChildProcess | null = null;
  reportUrl = "";
  browser: Browser | null = null;
  page: Page | null = null;
}

setWorldConstructor(SelftestWorld);
