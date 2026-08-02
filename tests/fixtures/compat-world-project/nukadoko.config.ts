import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: every scenario in this fixture stays off the wire (World/hook
// mechanics only). tests/compat-world.test.ts still runs against a fresh
// temp copy, same as every other `nuka run` test — `.nukadoko/` state gets
// written either way.
export default defineConfig({});
