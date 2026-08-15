import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: every browser navigation in this fixture uses a "data:" URL
// (its coverage is entirely about which trace chunk a
// given navigation lands in, not about talking to a real server).
export default defineConfig({});
