import { generateId } from "../receipt/receipt-id.js";

// Responsibility: the scenario id format from docs/spec.md "The state
// directory": `scn-<YYYYMMDD-HHMMSS>-<4 alphanumeric>`, the same family as
// receipt ids — reuses receipt-id.ts's shared `generateId` rather than
// duplicating the date/random-suffix logic.

export function generateScenarioId(now: Date = new Date()): string {
  return generateId("scn", now);
}
