import { defineConfig } from "./nukadoko-shim.js";

// A single config.parameterTypes entry named "int": collides with
// cucumber-expressions' own built-in {int} type. Exists to reach
// buildStepBindings()'s own throw from `nuka run` (src/cli/run.ts), a path
// tests/binding-expression.test.ts already exercises directly against
// buildStepBindings() but no test yet drives through the CLI's own setup
// phase.
export default defineConfig({
  parameterTypes: [{ name: "int", regexp: /\d+/, transformer: (s: string) => Number(s) }],
});
