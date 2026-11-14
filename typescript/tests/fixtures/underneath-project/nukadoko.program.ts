import { defineProgram } from "./nukadoko-shim.js";

// A program that fails underneath its steps on some routes: a 5xx answer,
// and an error it reports with handled: false in its execution events.
// tests/underneath-run.test.ts reads how the run judges each.
export default defineProgram({
  serve: { command: "node app/server.mjs", ready: "/up" },
  env: { PORT: "{port}", EXECUTION_EVENTS: "{events}" },
});
