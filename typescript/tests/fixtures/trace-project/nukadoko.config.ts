import { defineConfig } from "./nukadoko-shim.js";

// The program under test is this config's program.
// A program that tags its log lines with the trace context, and an
// environment where it does not. tests/program-trace.test.ts reads each
// step's slice of its log.

export default defineConfig({
  program: () => ({
    serve: { command: "node app/server.mjs" },
    env: { PORT: "{port}" },
    environments: { untagged: { env: { TAG: "none" } } },
  }),
});
