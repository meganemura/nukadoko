import { defineProgram } from "./nukadoko-shim.js";

// A program that tags its lines the way an OpenTelemetry log bridge does,
// with the trace id and a span id of its own, and writes some of them
// after it answered. `buffered` holds every line until it stops, as a
// program whose output is buffered on a pipe. tests/program-log-late.test.ts
// reads where each line went.
export default defineProgram({
  serve: { command: "node app/server.mjs" },
  env: { PORT: "{port}" },
  environments: { buffered: { env: { BUFFERED: "1" } } },
});
