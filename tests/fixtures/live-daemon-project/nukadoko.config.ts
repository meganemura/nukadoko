import { defineConfig } from "./nukadoko-shim.js";

// `stateDir: "s"` and a placeholder `baseURL`, same reasons as
// tests/fixtures/live-session-project's own config: a live session's own
// unix socket path has to stay under the OS's short sun_path limit, and
// this project's own steps that touch `request`
// (features/steps/touch-request.ts) only ever open a request context,
// never issue a real call. The `readonly` environment exists only for the
// read-only-policy rejection this project's own `mutating` step exercises.
export default defineConfig({
  baseURL: "http://127.0.0.1:1",
  stateDir: "s",
  environments: {
    readonly: { policy: "read-only" },
  },
});
