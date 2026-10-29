import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { emit, newId } from "./events.mjs";

// The job worker: a process of its own that performs each job the server
// enqueued in JOBS_DIR, with the trace of the request that enqueued it.
// A job on the queue `parked` is never performed. It ends with the server.
const dir = process.env.JOBS_DIR;
process.on("disconnect", () => process.exit(0));

setInterval(() => {
  for (const name of readdirSync(dir)) {
    const job = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    if (job.queue === "parked") continue;
    const id = newId();
    emit({ trace: job.trace, kind: "db", id: newId(), parent: id, table: "rankings", op: "update", rows: 3, committed: true });
    emit({ trace: job.trace, kind: "job", id, name: job.name, queue: job.queue, phase: "perform", job_id: job.job_id });
    rmSync(path.join(dir, name));
  }
}, 10);
