import { defineProgram } from "./nukadoko-shim.js";

// A program that tags its log lines with the trace context, and an
// environment where it does not. tests/program-trace.test.ts reads each
// step's slice of its log.
export default defineProgram({
  serve: { command: "node app/server.mjs" },
  env: { PORT: "{port}" },
  environments: { untagged: { env: { TAG: "none" } } },
});
