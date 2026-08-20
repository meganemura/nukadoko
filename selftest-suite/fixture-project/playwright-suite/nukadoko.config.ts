import { defineConfig } from "nukadoko";

// Same NUKADOKO_SELFTEST_PW_PORT contract as this project's own
// playwright.config.ts (see that file's own comment): both configs must
// point `nuka run`/`nuka do` and `playwright test` at the one fixture
// server selftest-suite/features/steps/playwright-suite.ts starts, so both
// read the same environment variable rather than each guessing a literal
// port.
const port = process.env.NUKADOKO_SELFTEST_PW_PORT;
if (port === undefined) {
  throw new Error("NUKADOKO_SELFTEST_PW_PORT must be set before running this nukadoko config");
}

export default defineConfig({ baseURL: `http://127.0.0.1:${port}` });
