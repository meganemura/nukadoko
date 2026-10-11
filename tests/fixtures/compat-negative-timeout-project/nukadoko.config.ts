import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: every scenario in this fixture stays off the wire. Coverage
// is setDefaultTimeout(-1) and a step's own timeout beside it.
export default defineConfig({});
