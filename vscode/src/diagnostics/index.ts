// Responsibility: the one public surface src/extension.ts imports
// diagnostics logic through -- re-exports only, mirroring src/index/index.ts
// and src/extraction/index.ts's own barrels.
export { buildDiagnosticsFromCheckReport, type DiagnosticsEntry } from "./build-diagnostics.js";
export { buildUnresolvedDiagnostics } from "./build-unresolved-diagnostics.js";
