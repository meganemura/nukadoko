import { defineConfig } from "./nukadoko-shim.js";

// No program file: this fixture is only about BeforeAll/AfterAll's own
// once-per-run, ordering, and zero-pickles behavior — nothing here touches
// Playwright/HTTP.
export default defineConfig({});
