import { defineProgram } from "./nukadoko-shim.js";

// The world serves MCP over HTTP and writes execution events to the file
// {events} names. tests/mcp-measured.test.ts reads the step records.
export default defineProgram({
  serve: { command: "node app/server.mjs", ready: "/up" },
  env: { PORT: "{port}", EXECUTION_EVENTS: "{events}" },
});
