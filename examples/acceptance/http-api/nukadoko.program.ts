import { defineProgram } from "nukadoko";

// One API server for the whole run, on a port of its own. It keeps its
// items in memory, so a scenario sees the items earlier scenarios created,
// and each one claims only on what it created itself (S8).
export default defineProgram({
  serve: { command: "node src/server.ts", ready: "/items" },
  env: { PORT: "{port}" },
});
