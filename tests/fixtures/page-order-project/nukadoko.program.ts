import { defineProgram } from "./nukadoko-shim.js";

// A room page that re-fetches its state, with an answer the program can
// hold back. tests/page-order-run.test.ts reads what each Then's record
// says the page had received when it read it.
export default defineProgram({
  serve: { command: "node app/server.mjs" },
  env: { PORT: "{port}" },
});
