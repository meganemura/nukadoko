import { generateId } from "../record/record-id.js";

// Responsibility: the scenario id format from docs/spec.md "The state
// directory": `scn-<YYYYMMDD-HHMMSS>-<4 alphanumeric>`, the same family as
// step record ids — reuses record-id.ts's shared `generateId` rather than
// duplicating the date/random-suffix logic.

export function generateScenarioId(now: Date = new Date()): string {
  return generateId("scn", now);
}
