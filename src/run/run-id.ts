import { generateId } from "../receipt/receipt-id.js";

// Responsibility: the run id format (m4a-run-provenance task spec, decision
// 1): `run-<YYYYMMDD-HHMMSS>-<4 alphanumeric>`, the same id family as a
// receipt's `rcpt-...` and a scenario's own `scn-...` (src/run/scenario-
// id.ts) — reuses receipt-id.ts's shared `generateId` rather than
// duplicating the date/random-suffix logic, the same precedent scenario-
// id.ts already set. One id is generated once per `nuka run` invocation
// (cli/run.ts), never per pickle, so every scenario record that invocation
// writes can carry the same value (`ScenarioRecord.run_id`,
// src/run/record-types.ts) — the fact `nuka accept` (not yet implemented)
// will eventually need to identify "every record this one run wrote".

export function generateRunId(now: Date = new Date()): string {
  return generateId("run", now);
}
