import { defineConfig } from "./nukadoko-shim.js";

// A pure-step project, on purpose — every step here exists only to be a
// well-formed or structurally malformed `from` entry for `nuka steps`/`nuka
// describe`/`nuka check` to read; nothing about them needs a browser or an
// HTTP server.
export default defineConfig({});
