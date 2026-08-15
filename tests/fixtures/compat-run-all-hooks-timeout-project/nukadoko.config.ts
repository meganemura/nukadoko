import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: this fixture is only about BeforeAll's own `{ timeout }` and
// its failure fallout — nothing
// here touches Playwright/HTTP.
export default defineConfig({});
