import { readFileSync } from "node:fs";
import path from "node:path";
import type { Receipt } from "./types.js";

// Responsibility: the read-side counterpart to write-receipt.ts, built
// specifically for src/report/allure/emitter.ts. The whole allure-js-commons
// `ReporterRuntime`/`Writer` surface that emitter drives is synchronous by
// contract (every `Writer` method returns `void`, never a `Promise` —
// m3b-allure-emitter task spec's own api-facts.md, section 1.3), and the
// emitter's own public `emitScenario(...): void` is pinned to the same
// shape (that task's spec, decision 12: "この形にする"). write-receipt.ts's
// own `fs/promises` style would force `emitScenario` to become `async`,
// contradicting that pinned signature — so this reads synchronously instead
// (`readFileSync`), the same convention src/feature/load-features.ts already
// uses for its own filesystem reads, keeping the emitter's body free of
// `await` end to end.
//
// Takes the receipt's own directory directly (mirrors `writeReceipt
// (evidenceDir, receipt)`'s own parameter shape) rather than a receipt id —
// the id-to-directory convention (`<stateDir>/receipts/<id>`) belongs to
// src/run/run-scenario.ts (which this task does not touch), and the caller
// here (emitter.ts) already has to derive that path itself from the
// scenario record it is reading; growing this module's own contract to
// duplicate that convention isn't worth it for a one-line `path.join`.
//
// A missing or unparseable receipt.json is not this module's failure to
// surface: the emitter's own mapping treats a `null` result as "fall back
// to the record's own coarser status" (m3b-allure-emitter task spec,
// decision 12's own text: "読めない receipt は null として扱って写像を続け
// る"), so every read failure — file not found, malformed JSON, any other
// I/O error — collapses to the same `null` rather than being distinguished;
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
