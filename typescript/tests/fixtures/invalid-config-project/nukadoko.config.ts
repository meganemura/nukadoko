import { defineConfig } from "./nukadoko-shim.js";

// Deliberately invalid: `typo` is not a recognized config key. `as any`
// bypasses the type checker's excess-property check on purpose — this
// fixture's whole point is to prove the *runtime* loader also rejects an
// unknown key (a config author could reach this despite the type checker,
// e.g. via a hand-edited build artifact or a `// @ts-ignore`).
export default defineConfig({ typo: "features" } as any);
