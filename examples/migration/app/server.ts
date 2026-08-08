import { fileURLToPath } from "node:url";
import { createTodoApp } from "../../todo/app/server.js";

// This walkthrough is about glue code evolving -- cucumber-js-shaped compat
// steps, one producer/consumer pair already promoted to typed steps -- not
// about the app underneath it. Reusing examples/todo's own todo API outright
// keeps this example's only files worth reading its migration-shaped glue,
// not a second bespoke app duplicating examples/todo/app/server.ts's own
// header comment for nothing.

// Only starts a listening server when this file is run directly (`tsx
// app/server.ts`), never when imported -- same convention as examples/todo's
// own server.ts, for the same reason (a smoke test imports createTodoApp
// directly to run it in-process on an ephemeral port instead).
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const server = createTodoApp();
  server.listen(4000, () => {
    console.log(
      "todo app listening on http://localhost:4000 (examples/migration, reusing examples/todo's app)",
    );
  });
}
