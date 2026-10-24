import { defineConfig } from "./nukadoko-shim.js";

// Every config-coherence *warning*, and
// nothing that rises to an error: `nuka check` must still exit 0 here since
// these are warnings only, not errors.
//   - envFiles names a file that doesn't exist on disk.
//   - environments.staging.envFiles names a file that doesn't exist either.
//   - secrets.public names a key no configured envFile actually defines
//     (secrets-public-key-unknown).
export default defineConfig({
  envFiles: [".env.missing"],
  secrets: { public: ["UNKNOWN_KEY"] },
  environments: {
    staging: {
      envFiles: [".env.staging-missing"],
    },
  },
});
