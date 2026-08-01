import { generateId } from "../receipt/receipt-id.js";

// Responsibility: the scenario id format from docs/spec.md "The state
// directory" / run-execution-design.md: `scn-<YYYYMMDD-HHMMSS>-<4
// alphanumeric>`, the same family as receipt ids — reuses receipt-id.ts's
// shared `generateId` rather than duplicating the date/random-suffix logic
// (this task's spec: "receipt-id.ts の一般化か並置は任せる"; generalizing was
// the choice made).

export function generateScenarioId(now: Date = new Date()): string {
  return generateId("scn", now);
}
