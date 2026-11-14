import { defineProgram } from "./nukadoko-shim.js";

// A program that writes execution events (docs/execution-events.md) from
// two processes, a server and the job worker it starts, to the file
// {events} names. tests/program-events.test.ts reads where each line went.
export default defineProgram({
  serve: { command: "node app/server.mjs", ready: "/up" },
  env: { PORT: "{port}", EXECUTION_EVENTS: "{events}", ADMIN_TOKEN: "{token}", JOBS_DIR: "{dir}/jobs" },
});
