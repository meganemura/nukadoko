import { defineConfig } from "./nukadoko-shim.js";

// Deliberately invalid: `Public` inside `secrets` differs from the real key
// (`public`) only in case, and sits one level below the object `typo`
// (invalid-config-project's own fixture) reaches. The unrecognized-keys
// issue this raises names a `path` of `["secrets"]`, not `[]`, so the
// suggestion has to be looked up against that object's own keys, not the
// top-level config's.
export default defineConfig({ secrets: { Public: ["KEY"] } } as any);
