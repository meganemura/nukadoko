import { readFileSync } from "node:fs";
import path from "node:path";
import type { Receipt } from "./types.js";

// Responsibility: the read-side counterpart to write-receipt.ts, built
// specifically for src/report/allure/emitter.ts. The whole allure-js-commons
// `ReporterRuntime`/`Writer` surface that emitter drives is synchronous by
// contract (every `Writer` method returns `void`, never a `Promise` —
// verified against allure-js-commons' own `Writer` type), and the emitter's
// own public `emitScenario(...): void` is pinned to that same synchronous
// shape. write-receipt.ts's own `fs/promises` style would force
// `emitScenario` to become `async`,
// contradicting that pinned signature — so this reads synchronously instead
// (`readFileSync`), the same convention src/feature/load-features.ts already
// uses for its own filesystem reads, keeping the emitter's body free of
// `await` end to end.
//
// Takes the receipt's own directory directly (mirrors `writeReceipt
// (evidenceDir, receipt)`'s own parameter shape) rather than a receipt id —
// the id-to-directory convention (`<stateDir>/receipts/<id>`) belongs to
// src/run/run-scenario.ts, and the caller here (emitter.ts) already has to
// derive that path itself from the scenario record it is reading; growing
// this module's own contract to duplicate that convention isn't worth it for
// a one-line `path.join`. `readReceiptById` below is the one exception:
// `nuka do --use` has no record to derive a directory from, only a bare id
// typed on the command line, so it is worth this module knowing the
// convention for that one caller.
//
// A missing or unparseable receipt.json is not this module's failure to
// surface: the emitter's own mapping treats a `null` result as "fall back
// to the record's own coarser status", so every read failure — file not
// found, malformed JSON, any other I/O error — collapses to the same
// `null` rather than being distinguished;
// a caller that cannot act differently on any of them has no use for the
// difference.

export function readReceipt(receiptDir: string): Receipt | null {
  try {
    const content = readFileSync(path.join(receiptDir, "receipt.json"), "utf8");
    return JSON.parse(content) as Receipt;
  } catch {
    return null;
  }
}

// `nuka do --use <receipt-id>` is the one caller that hands this module a
// receipt id typed on the command line rather than one
// this tool already wrote down and is reading back (`readReceiptsForRecord`,
// src/report/receipts.ts, only ever cites ids its own scenario record
// carries) — so, unlike every other reader here, the id itself is untrusted
// input. A real id is only ever `[a-z0-9-]+` (receipt-id.ts's own
// `generateId`); rejecting anything else up front, before it is ever joined
// into a path, is what keeps `--use ../../etc/passwd` from resolving outside
// `<stateDir>/receipts/` at all — same reasoning as session/name.ts's own
// `VALID_SESSION_NAME`. A rejected id collapses into the same `null` a
// merely-absent one already produces: `--use`'s own caller reports both as
// "no such receipt", so a malformed id gets no signal about which failure
// mode it hit.
const VALID_RECEIPT_ID = /^[a-z0-9-]+$/;

/** `readReceipt` plus the id -> directory convention every writer here
 * already shares (`<stateDir>/receipts/<id>`, e.g. src/cli/do.ts's own
 * `relativeDir`) — a second `readReceipt(path.join(...))` call site would
 * otherwise have to know that convention itself. */
export function readReceiptById(rootDir: string, stateDir: string, receiptId: string): Receipt | null {
  if (!VALID_RECEIPT_ID.test(receiptId)) {
    return null;
  }
  return readReceipt(path.join(rootDir, stateDir, "receipts", receiptId));
}
