import { defineConfig } from "./nukadoko-shim.js";

// Two invented credentials in the browser context's options, neither of
// them a secret nukadoko loaded, so redaction cannot hide them: Playwright
// writes its context options into the trace it records, and the step
// record must not hold them through Playwright's own files. The test
// starts the page server and names it in CHANNELS_BASE.
export default defineConfig({
  browserContext: {
    extraHTTPHeaders: { Authorization: "Bearer invented-header-token-5521" },
    httpCredentials: { username: "fixture-user", password: "invented-password-7730" },
  },
});
