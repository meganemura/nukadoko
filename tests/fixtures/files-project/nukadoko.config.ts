import { defineConfig } from "./nukadoko-shim.js";

// No browser and no server: each producer here runs a child process
// through `runCommand` in the project directory (or does not), and each
// claim step reads the files that process changed from the producer's
// step record.
export default defineConfig({});
