// Responsibility: the one public surface src/extension.ts imports
// diagnostics logic through -- re-exports only, mirroring src/index/index.ts
// and src/extraction/index.ts's own barrels.
export { readCheckReport, type CheckReportReading, type DiagnosticsEntry } from "./build-diagnostics.js";
export { buildUnreadableDiagnostics, buildUnresolvedDiagnostics } from "./build-unresolved-diagnostics.js";
