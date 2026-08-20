import { defineConfig } from "./nukadoko-shim.js";

// Two named environments whose `version` probe either succeeds or always
// throws. tests/fixtures/environments-project already exercises both
// shapes through `nuka do` (tests/environment.test.ts), but no test yet
// drives either one through `nuka run`'s own setup phase (cli/run.ts's own
// probeVersion() call), which is a separate call site from cli/do.ts's.
export default defineConfig({
  environments: {
    "probe-ok": {
      version: () => "9.9.9",
    },
    "probe-throws": {
      version: () => {
        throw new Error("probe boom");
      },
    },
  },
});
