import { defineConfig } from "./nukadoko-shim.js";

// browser.args carries the flag Chromium 149 needs to expose
// navigator.modelContext at all (--enable-features=WebMCPTesting). This
// package never injects that flag itself: a project that wants the
// experimental WebMCP surface to work states it here, the same way any
// other Playwright launch option is stated.
export default defineConfig({
  browser: { args: ["--enable-features=WebMCPTesting"] },
});
