import { defineConfig } from "./nukadoko-shim.js";

// A test that runs a scenario here writes nukadoko.program.ts beside this
// file, whose url is the test server it started.
export default defineConfig({ showRequests: true, envFiles: [".env"], secrets: { redact: ["NOTE_TOKEN"] } });
