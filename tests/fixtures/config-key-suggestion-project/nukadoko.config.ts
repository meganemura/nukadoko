import { defineConfig } from "./nukadoko-shim.js";

// Deliberately invalid: `baseUrl` differs from the real key (`baseURL`)
// only in case. `as any` bypasses the type checker's excess-property check
// on purpose — this fixture's whole point is to prove the *runtime* loader
// names the correctly-cased key back to a config author who typed this.
export default defineConfig({ baseUrl: "http://example.com" } as any);
