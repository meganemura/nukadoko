import { randomBytes } from "node:crypto";

// Responsibility: the receipt_id format from docs/spec.md "Receipts":
// `rcpt-<YYYYMMDD-HHMMSS>-<4 alphanumeric>`. The timestamp component is
// local wall-clock digits, not a real timestamp field — it exists to keep
// ids roughly sortable and human-scannable; `started_at`/`finished_at` on
// the receipt itself carry the actual ISO 8601 timestamps, timezone
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

export function generateReceiptId(now: Date = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `rcpt-${date}-${time}-${randomSuffix(4)}`;
}
