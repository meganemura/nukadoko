import { randomBytes } from "node:crypto";

// Responsibility: the `<prefix>-<YYYYMMDD-HHMMSS>-<4 alphanumeric>` id
// format docs/spec.md "Records" and "The state directory" both use —
// `step-...` for a step record, `scn-...` for a scenario record
// (src/run/scenario-id.ts).
// Generalized into `generateId` here rather than duplicated, since the two
// ids are the same family with only the prefix differing. The timestamp
// component is local wall-clock digits, not a real timestamp field — it
// exists to keep ids roughly sortable and human-scannable; a record's own
// started_at/finished_at carry the actual ISO 8601 timestamps, timezone
// included.

const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(length: number): string {
  let out = "";
  for (const byte of randomBytes(length)) {
    out += ALPHANUMERIC.charAt(byte % ALPHANUMERIC.length);
  }
  return out;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function generateId(prefix: string, now: Date = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${date}-${time}-${randomSuffix(4)}`;
}

export function generateStepRecordId(now: Date = new Date()): string {
  return generateId("step", now);
}
