import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { emit, newId } from "./events.mjs";

// The job worker: a process of its own that performs each job the server
// enqueued in JOBS_DIR, with the trace of the request that enqueued it.
// A job on the queue `parked` is never performed, and one with
// `not_before` waits until then. `ReceiptJob` evaluates the flag
// `quick_reorder` for everyone, from QUICK_REORDER, and its line names no
// gate. It ends with the server.
const dir = process.env.JOBS_DIR;
process.on("disconnect", () => process.exit(0));

setInterval(() => {
  for (const name of readdirSync(dir)) {
    const job = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    if (job.queue === "parked" || Date.now() < (job.not_before ?? 0)) continue;
    const id = newId();
    if (job.name === "ReceiptJob") {
      emit({ trace: job.trace, kind: "flag", id: newId(), parent: id, name: "quick_reorder", side: process.env.QUICK_REORDER === "true" ? "on" : "off" });
    }
    emit({ trace: job.trace, kind: "db", id: newId(), parent: id, table: "rankings", op: "update", rows: 3, committed: true });
    emit({ trace: job.trace, kind: "job", id, name: job.name, queue: job.queue, phase: "perform", job_id: job.job_id });
    rmSync(path.join(dir, name));
  }
}, 10);
