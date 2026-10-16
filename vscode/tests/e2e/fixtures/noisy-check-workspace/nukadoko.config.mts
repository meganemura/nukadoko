import { defineConfig } from "nukadoko";

// Fixture for tests/e2e/diagnostics-command.test.ts: its one step file
// logs when it is imported, so `nuka check --json` prints that line on
// stdout before its JSON report. .mts for the reason
// diagnostics-workspace/nukadoko.config.mts gives.
export default defineConfig({});
