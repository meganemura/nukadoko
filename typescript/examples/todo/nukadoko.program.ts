import { defineProgram } from "nukadoko";

// How nukadoko starts the todo app: once for each run, on a port of its
// own, ready when GET /todos answers, and stopped after the scenarios, so
// no terminal has to keep it running. The v2 environment is the same app
// with its text field renamed (README.md, Part 2): `nuka run --env v2`.
export default defineProgram({
  serve: { command: "node app/server.ts --port {port}", ready: "/todos" },
  environments: {
    v2: { env: { TODO_APP_V2: "1" } },
  },
});
