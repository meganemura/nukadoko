import { defineConfig } from "./nukadoko-shim.js";

// No browser and no server: every step here runs a child process through
// `runCommand`, and the test reads `observed.processes` from the step
// record. `.env` supplies the secret one step passes as an argument.
export default defineConfig({
  envFiles: [".env"],
});
