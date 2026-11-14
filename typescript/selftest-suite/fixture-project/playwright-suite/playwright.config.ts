import { defineConfig } from "playwright/test";

// NUKADOKO_SELFTEST_PW_PORT is set by selftest-suite/features/steps/
// playwright-suite.ts before it spawns `playwright test` here: the fixture
// server (server.ts) binds an ephemeral port (`listen(0, ...)`), so the
// port can only be known once that server is already listening, never as a
// literal in this file. This project's own nukadoko.config.ts reads the
// same variable, so both runners point at the one server this scenario
// starts.
const port = process.env.NUKADOKO_SELFTEST_PW_PORT;
if (port === undefined) {
  throw new Error("NUKADOKO_SELFTEST_PW_PORT must be set before running this Playwright config");
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}` },
});
