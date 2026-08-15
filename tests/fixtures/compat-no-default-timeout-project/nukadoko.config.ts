import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: this fixture is only about proving `setDefaultTimeout` never
// being called leaves a compat step unbounded — nothing here touches
// Playwright/HTTP.
export default defineConfig({});
