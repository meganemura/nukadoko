import { z } from "zod";
import { defineWorld, setWorldConstructor } from "nukadoko/compat";

// Stage 1.5 of README.md: exactly one World key promoted so far --
// `seededCount`, written by ../steps/seed-legacy-todos.ts -- validated on
// every write from here on (a write that fails this schema fails the step
// and is never recorded, docs/spec.md "Compat steps"). `note` stays an
// ordinary, undeclared bag field: the migration hasn't reached it yet, and
// leaving it that way on purpose is the point of a mid-migration example
// (docs/spec.md, migration-door rule: "transitional two-home states ...
// are accepted rather than forbidden").
const worldSchemas = {
  seededCount: z.number(),
};

export class MigrationWorld extends defineWorld(worldSchemas) {
  /** Written by ../steps/legacy-note-stash.ts, read back by the same file --
   * a plain, undeclared World write, measured (it still shows up in a
   * receipt's `world.writes`) but not validated, exactly the cucumber-js
   * `this.foo = ...` convention compat steps keep. The explicit `= undefined`
   * initializer (not just `note?: string`) matters: it makes `note` a real
   * own property from construction, so it is already instrumented at wrap
   * time -- src/compat/world-instrumentation.ts's own "hole 1" limit only
   * bites a key a step creates for the first time mid-execution; this key
   * exists before any step ever runs. */
  note: string | undefined = undefined;
}

setWorldConstructor(MigrationWorld);
