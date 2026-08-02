import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: this fixture is only about BeforeAll's own `{ timeout }` and
// its failure fallout (m22-compat-run-scope task spec, item 2) — nothing
// here touches Playwright/HTTP.
export default defineConfig({});
