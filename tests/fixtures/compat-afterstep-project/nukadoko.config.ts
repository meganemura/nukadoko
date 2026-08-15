import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: every scenario in this fixture stays off the wire (its
// coverage is entirely about AfterStep hook mechanics — how many times it
// runs, which step_index it records, whether it's tag-filtered, and what
// HookParameter.result it receives).
export default defineConfig({});
