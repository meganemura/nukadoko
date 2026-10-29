import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { emit, emitRaw, newId } from "./events.mjs";

// Writes one line per operation, after the lines of what happened inside
// it, with the traceparent the request arrived with. `/scores` enqueues a
// job the worker performs before the answer goes out; `/scores?park=1`
// enqueues one nobody performs. `/late` writes its request line 600 ms
// after it answered, or when the server is told to stop, whichever comes
// first. `/spliced` splits one line across two writes with another line
// between them. `/secret` writes the world's token inside an event.
// `/inlet` answers where the events file is, who may read it, and which
// variables of the server's environment name a file nukadoko made for
// events. `/up`, the readiness probe, writes its line before it answers,
// so the line is in the file before any step reads it: written after, it
// would reach the first step's reading as a line no step owns, or not,
// as the race went.
const jobs = process.env.JOBS_DIR;
mkdirSync(jobs, { recursive: true });
fork(new URL("./worker.mjs", import.meta.url).pathname);

const held = new Set();
process.on("SIGTERM", () => {
  for (const line of held) emit(line);
  process.exit(0);
});

const inlet = () => {
  const file = process.env.EXECUTION_EVENTS ?? null;
  const named = Object.entries(process.env)
    .filter(([, value]) => value?.startsWith(path.join(os.tmpdir(), "nukadoko-events-")))
    .map(([name]) => name);
  if (file === null) return { file, fileMode: null, dirMode: null, named };
  return { file, fileMode: statSync(file).mode & 0o777, dirMode: statSync(path.dirname(file)).mode & 0o777, named };
};

const waitUntilGone = async (file) => {
  while (existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 5));
};

createServer(async (req, res) => {
  const trace = req.headers.traceparent ?? `00-${randomBytes(16).toString("hex")}-${newId()}-01`;
  const id = newId();
  const url = new URL(req.url, "http://localhost");
  let route = url.pathname;
  let status = 200;
  let body = "ok";
  if (url.pathname.startsWith("/rooms/")) {
    route = "/rooms/:id";
    emit({ trace, kind: "db", id: newId(), parent: id, table: "rooms", op: "read", rows: 1 });
  } else if (url.pathname === "/scores") {
    status = 303;
    emit({ trace, kind: "db", id: newId(), parent: id, table: "scores", op: "insert", rows: 1, ids: [42], committed: true });
    const parked = url.searchParams.get("park") === "1";
    const job = { trace, name: "ScoreRecalcJob", queue: parked ? "parked" : "default", job_id: newId() };
    emit({ trace, kind: "job", id: newId(), parent: id, name: job.name, queue: job.queue, phase: "enqueue", job_id: job.job_id });
    const file = path.join(jobs, `${job.job_id}.json`);
    writeFileSync(file, JSON.stringify(job));
    if (!parked) await waitUntilGone(file);
  } else if (url.pathname === "/spliced") {
    emitRaw(`{"trace":"${trace}","kind":"db",`);
    emit({ trace, kind: "flag", id: newId(), parent: id, name: "score_input_slider", side: "off" });
    emitRaw(`"table":"rooms","op":"read"}\n`);
  } else if (url.pathname === "/secret") {
    emit({ trace, kind: "db", id: newId(), parent: id, table: "admins", op: "read", rows: 1, x_note: `token ${process.env.ADMIN_TOKEN}` });
  } else if (url.pathname === "/inlet") {
    body = JSON.stringify(inlet());
  }
  const line = { trace, kind: "request", id, method: req.method, route, status };
  if (url.pathname === "/up") emit(line);
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
  if (url.pathname === "/up") return;
  if (url.pathname !== "/late") {
    emit(line);
    return;
  }
  held.add(line);
  setTimeout(() => {
    if (held.delete(line)) emit(line);
  }, 600);
}).listen(Number(process.env.PORT));
