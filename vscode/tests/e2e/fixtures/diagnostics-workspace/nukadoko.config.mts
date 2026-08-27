import { defineConfig } from "nukadoko";

// Fixture for tests/e2e/diagnostics-command.test.ts: this whole project
// exists to give `nuka check` exactly one issue to report (its one feature
// steps on a pattern features/steps/unrelated-step.mts deliberately does not
// define), so that test can confirm the nukadoko.check command really
// spawns `nuka check` and turns its report into a diagnostic.
//
// .mts, not .ts: this fixture lives under vscode/, whose own package.json
// has no "type": "module", so a plain .ts file here would load as
// CommonJS and fail to resolve `import ... from "nukadoko"` at all (that
// package publishes only an ESM build). .mts is unambiguous ESM regardless
// of the nearest package.json (src/config/load-config.ts's own comment on
// nukadoko.config.mts explains the same rule for a real project's config).
export default defineConfig({});
