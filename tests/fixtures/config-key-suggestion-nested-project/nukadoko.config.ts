import { defineConfig } from "./nukadoko-shim.js";

// Deliberately invalid: `baseUrl` inside `environments.staging` differs
// from the real key (`baseURL`) only in case, and sits one level below the
// object `typo` (invalid-config-project's own fixture) reaches — the
// unrecognized-keys issue this raises names a `path` of `["environments",
// "staging"]`, not `[]`, so the suggestion has to be looked up against
// `environmentConfigSchema`'s own keys, not the top-level config's.
export default defineConfig({ environments: { staging: { baseUrl: "http://example.com" } } } as any);
