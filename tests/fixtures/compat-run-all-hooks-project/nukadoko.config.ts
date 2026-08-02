import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: this fixture is only about BeforeAll/AfterAll's own
// once-per-run, ordering, and zero-pickles behavior (m22-compat-run-scope
// task spec, item 2) — nothing here touches Playwright/HTTP.
export default defineConfig({});
