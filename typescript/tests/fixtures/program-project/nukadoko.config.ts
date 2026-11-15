import { defineConfig } from "./nukadoko-shim.js";

// The program under test is this config's program.
// A program nukadoko starts for each world: app/server.mjs on a port of
// its own, with a database path in the world's directory and the world's
// token. tests/program-run.test.ts reads all three back through the steps.

export default defineConfig({
  program: () => ({
    serve: { command: "node app/server.mjs", ready: "/whoami" },
    env: { PORT: "{port}", DB: "{dir}/db.sqlite3", TOKEN: "{token}" },
  }),
});
