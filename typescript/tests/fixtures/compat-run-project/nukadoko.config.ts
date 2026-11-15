import { defineConfig } from "./nukadoko-shim.js";

// tests/compat-run.test.ts writes a program into this config at
// run time, naming a real test server's address as its url: only the one
// scenario that actually opens a request context needs it.
export default defineConfig({});
