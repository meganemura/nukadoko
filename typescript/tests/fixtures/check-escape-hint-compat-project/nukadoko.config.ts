import { defineConfig } from "./nukadoko-shim.js";

// The parameter type the pattern uses is registered from compat code, not
// from config.parameterTypes. The escape hint must still see it.
export default defineConfig({});
