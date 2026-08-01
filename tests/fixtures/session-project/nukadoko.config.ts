import { defineConfig } from "./nukadoko-shim.js";

// Placeholder baseURL: session.test.ts / session-browser.test.ts each spin
// up their own node:http server on an ephemeral port and overwrite this
// file in the copied temp directory before running, since the real port is
// only known at test run time. This committed version only needs to be
// valid enough to type-check and to load without a ConfigError if anything
// ever runs against the fixture directly.
export default defineConfig({ baseURL: "http://127.0.0.1:1" });
