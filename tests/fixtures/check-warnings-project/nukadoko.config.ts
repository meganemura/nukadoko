import { defineConfig } from "./nukadoko-shim.js";

// Every config-coherence *warning* this task's spec names (item 5), and
// nothing that rises to an error: `nuka check` must still exit 0 here
// ("警告のみで exit 0").
//   - envFiles names a file that doesn't exist on disk.
//   - environments.staging.envFiles names a file that doesn't exist either.
//   - secrets.public names a key no configured envFile actually defines.
export default defineConfig({
  envFiles: [".env.missing"],
  secrets: { public: ["UNKNOWN_KEY"] },
  environments: {
    staging: {
      envFiles: [".env.staging-missing"],
    },
  },
});
