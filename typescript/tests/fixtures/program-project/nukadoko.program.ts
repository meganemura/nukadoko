import { defineProgram } from "./nukadoko-shim.js";

// A program nukadoko starts for each world: app/server.mjs on a port of
// its own, with a database path in the world's directory and the world's
// token. tests/program-run.test.ts reads all three back through the steps.
export default defineProgram({
  serve: { command: "node app/server.mjs", ready: "/whoami" },
  env: { PORT: "{port}", DB: "{dir}/db.sqlite3", TOKEN: "{token}" },
});
