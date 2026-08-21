import { defineConfig } from "./nukadoko-shim.js";

// Deliberately sets no `envFiles` at all — unlike external-driver-project's
// own config, which always sets one. `config.envFiles` has no zod default
// (`z.array(z.string()).optional()`, src/config/schema.ts), so this project
// exists to keep that `undefined` case reachable through a fixture rather
// than only through the schema itself.
export default defineConfig({});
