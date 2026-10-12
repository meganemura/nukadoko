import { defineConfig } from "./nukadoko-shim.js";

// One step per capture type against a schema, each in its own scenario so a
// run reports each verdict alone. Steps named `bad-*` always fail args
// validation at run; steps named `ok-*` pass. `nuka check` must agree.
export default defineConfig({
  parameterTypes: [{ name: "custom", regexp: /\d+/, transformer: (s: string) => Number(s) }],
});
