import { defineProgram } from "./nukadoko-shim.js";

// One program per world, holding its accounts in memory, so a scenario
// sees what an earlier scenario of the same pass left in it.
export default defineProgram({
  serve: { command: "node app/server.mjs", ready: "/accounts" },
  env: { PORT: "{port}" },
});
