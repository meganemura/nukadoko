import { Then } from "nukadoko/compat";
import type { MigrationWorld } from "../support/world.js";

// RegExp pattern, not a cucumber-expression -- legacy glue is often
// regex-heavy, and the migration door has to admit it unchanged
// (docs/spec.md "Compat steps"). The captured count arrives as a plain
// string (RegExp semantics), unlike a typed step's coerced `{int}`.
Then(/^the todo list has (\d+) todos?$/, async function (this: MigrationWorld, count: string) {
  const res = await this.request.get("/todos");
  const todos = (await res.json()) as unknown[];
  if (todos.length !== Number(count)) {
    throw new Error(`expected ${count} todos, found ${todos.length}`);
  }
});
