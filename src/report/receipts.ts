import path from "node:path";
import { readReceipt } from "../receipt/read-receipt.js";
import type { Receipt } from "../receipt/types.js";
import type { ScenarioRecord } from "../run/record-types.js";

// Responsibility: read every receipt.json a scenario record's own steps
// reference, once per record (m3c-messages-emitter task spec, decision 2) —
// pulled up from src/report/allure/emitter.ts's own `receiptsForRecord`
// (its original home) into src/report/ itself because
// src/report/messages/emitter.ts now needs the identical read for the
// identical reason (both emitters map the same record.json/receipt.json
// pair, just onto different output shapes).
//
// `AllureEmitterOptions`/`MessagesEmitterOptions` each carry no `stateDir`
// of their own — a step's receipt directory is instead derived from
// `record.evidence.dir` (`"<stateDir>/scenarios/<scenarioId>"`,
// src/run/run-scenario.ts:431): two levels up is the same `<stateDir>` every
// step receipt in this run was written under
// (`<stateDir>/receipts/<receiptId>`, run-scenario.ts:854/941). Deriving it
// from a value the record already carries — rather than growing either
// emitter's own pinned options shape — keeps both interfaces untouched.
//
// A missing or unparseable receipt.json collapses to `null` (read-receipt.ts
// itself makes that call); this function only decides *which* receipts to
// read, once each, keyed by id.

export function readReceiptsForRecord(rootDir: string, record: ScenarioRecord): ReadonlyMap<string, Receipt | null> {
  const receiptsDir = path.join(rootDir, path.dirname(path.dirname(record.evidence.dir)), "receipts");
  const receipts = new Map<string, Receipt | null>();
  for (const step of record.steps) {
    if (step.receipt !== null && !receipts.has(step.receipt)) {
      receipts.set(step.receipt, readReceipt(path.join(receiptsDir, step.receipt)));
    }
  }
  return receipts;
}
