import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

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

/** Whether `value` has the shape `generateId(prefix)` gives: one path
 * segment, never `..` or a separator. An id read back from disk is joined
 * into a path, so a value of any other shape is refused rather than
 * followed. Pure. */
export function isGeneratedId(prefix: string, value: string): boolean {
  return new RegExp(`^${prefix}-[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$`).test(value);
}

export function generateStepRecordId(now: Date = new Date()): string {
  return generateId("step", now);
}

// Four random characters per second leave room for two records of one fast
// run to draw the same id. A recursive mkdir would hand the second record the
// first one's directory, so the directory is created exclusively and a taken
// id is drawn again.
export async function createRecordDir(parentDir: string, generate: () => string): Promise<{ id: string; dir: string }> {
  await mkdir(parentDir, { recursive: true });
  for (;;) {
    const id = generate();
    const dir = path.join(parentDir, id);
    try {
      await mkdir(dir);
      return { id, dir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
