import { defineConfig } from "./nukadoko-shim.js";

// One step whose pattern names a parameter type that does not exist, used
// by three scenarios. Its lines cannot match anything until the pattern
// builds, so they are not undefined steps.
export default defineConfig({});
