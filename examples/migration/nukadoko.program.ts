import { defineProgram } from "nukadoko";

// The app is examples/todo's todo API, served as it is: this walkthrough is
// about glue code, not the app under it, and a second app would only copy
// that one. nukadoko starts it for each run on a port of its own and stops
// it after the scenarios.
export default defineProgram({
  serve: { command: "node ../todo/app/server.ts --port {port}", ready: "/todos" },
});
