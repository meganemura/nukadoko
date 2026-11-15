import { defineConfig } from "./nukadoko-shim.js";

// The program under test is this config's program.
// One program per world, holding its accounts in memory, so a scenario
// sees what an earlier scenario of the same pass left in it.

export default defineConfig({
  program: () => ({
    serve: { command: "node app/server.mjs", ready: "/accounts" },
    env: { PORT: "{port}" },
  }),
});
