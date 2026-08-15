import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose — the
// two scenarios here exist only to be structurally broken `from` targets
// for `nuka check` to find; nothing about them needs a browser or an HTTP
// server.
export default defineConfig({});
