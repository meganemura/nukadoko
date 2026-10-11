import { Then } from "nukadoko/compat";
import type { MigrationWorld } from "../support/world.js";

// RegExp pattern, not a cucumber-expression -- legacy glue is often
// regex-heavy, and the migration door has to admit it unchanged
// (docs/spec.md "Compat steps"). `(\d+)` is the built-in int parameter
// type, so the captured count arrives as a number, the same conversion
// cucumber-js applies to that group.
Then(/^the todo list has (\d+) todos?$/, async function (this: MigrationWorld, count: number) {
  const res = await this.request.get("/todos");
  const todos = (await res.json()) as unknown[];
  if (todos.length !== Number(count)) {
    throw new Error(`expected ${count} todos, found ${todos.length}`);
  }
});
