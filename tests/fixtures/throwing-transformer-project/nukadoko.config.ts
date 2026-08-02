import { defineConfig } from "./nukadoko-shim.js";

// One `config.parameterTypes` entry whose transformer always throws
// (fix-scenario-step-backstop task spec): proves src/run/run-scenario.ts's
// per-step backstop, not the transformer itself — cucumber-expressions
// itself never catches a transformer's throw and match-step.ts deliberately
// doesn't either (that file's own header comment, decision 5), so this
// fixture's job is only to make one actually fire during a real `nuka run`.
export default defineConfig({
  parameterTypes: [
    {
      name: "exploding",
      regexp: /\w+/,
      transformer: (_s: string) => {
        throw new Error("custom transformer exploded");
      },
    },
  ],
});
