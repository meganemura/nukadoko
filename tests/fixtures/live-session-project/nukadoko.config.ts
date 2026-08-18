import { defineConfig } from "./nukadoko-shim.js";

// `stateDir: "s"` (rather than the default ".nukadoko") is this fixture's
// own accommodation for tests/live-session.test.ts's shallow temp
// directory: a live session's own unix socket path
// (cache/sessions/<env>/<name>.sock) has to stay under the OS's ~104-byte
// sun_path limit, and every byte saved on stateDir is a byte of headroom
// for that. baseURL is a placeholder — the fixture's own steps that touch
// `request` (features/steps/touch-request.ts) only ever open a request
// context, never issue a real call, so nothing here needs to resolve.
export default defineConfig({ baseURL: "http://127.0.0.1:1", stateDir: "s" });
