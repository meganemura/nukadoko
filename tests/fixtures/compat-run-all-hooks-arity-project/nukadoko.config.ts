import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: this fixture is only about the two refusal shapes cli/run.ts's
// own runOneRunHook applies to a run-scope hook (BeforeAll/AfterAll) before
// it ever calls the hook's own body. Nothing here touches Playwright/HTTP.
export default defineConfig({});
