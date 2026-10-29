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
// enqueues one nobody performs; `/scores?rollback=1` inserts inside a
// transaction that rolls back, and answers 422. `/late` writes its
// request line 600 ms after it answered, or when the server is told to
// stop, whichever comes first. `/after` writes its request line at once
// and a committed insert 500 ms later, or at the stop: a writer slower
// than the claim that reads it. `/slow` writes its request line 300 ms
// after it answered, and not at the stop: only a wait before the stop
// reads it. `/spliced` splits one line across two writes with another line
// between them. `/secret` writes the world's token inside an event.
// `/inlet` answers where the events file is, who may read it, and which
// variables of the server's environment name a file nukadoko made for
// events. `/lobby` reads the rooms, asks the flag `score_input_slider`, and
// records that it asked as one committed insert into `events`: a GET whose
// bookkeeping writes a row. `/up`, the readiness probe, writes its line before it answers,
// so the line is in the file before any step reads it: written after, it
// would reach the first step's reading as a line no step owns, or not,
// as the race went.
//
// The flag `quick_reorder` is on for everyone when QUICK_REORDER is
// `true`, and otherwise for each person `/switches?as=` turned it on
// for. `/orders/:id?as=` evaluates it for that person and answers
// `reorder` or `plain`, or `missing` for order 404; `/reorders?as=`
// answers 201 only where it is on. `/receipts` enqueues a job the worker
// performs 600 ms later, which evaluates the flag itself.
const jobs = process.env.JOBS_DIR;
mkdirSync(jobs, { recursive: true });
fork(new URL("./worker.mjs", import.meta.url).pathname);

const held = new Set();
const switchedOn = new Set();

const quickReorder = (who) => {
  if (process.env.QUICK_REORDER === "true") return { side: "on", gate: "boolean" };
  if (switchedOn.has(who)) return { side: "on", gate: "actor" };
  return { side: "off", gate: "boolean" };
};
process.on("SIGTERM", () => {
  for (const line of held) emit(line);
  process.exit(0);
});
const hold = (line, ms) => {
  held.add(line);
  setTimeout(() => {
    if (held.delete(line)) emit(line);
  }, ms);
};

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
  } else if (url.pathname === "/scores" && url.searchParams.get("rollback") === "1") {
    status = 422;
    const tx = newId();
    emit({ trace, kind: "db", id: newId(), parent: tx, table: "scores", op: "insert", rows: 1 });
    emit({ trace, kind: "tx", id: tx, parent: id, phase: "rollback" });
  } else if (url.pathname === "/scores") {
    status = 303;
    emit({ trace, kind: "db", id: newId(), parent: id, table: "scores", op: "insert", rows: 1, ids: [42], committed: true });
    const parked = url.searchParams.get("park") === "1";
    const job = { trace, name: "ScoreRecalcJob", queue: parked ? "parked" : "default", job_id: newId() };
    emit({ trace, kind: "job", id: newId(), parent: id, name: job.name, queue: job.queue, phase: "enqueue", job_id: job.job_id });
    const file = path.join(jobs, `${job.job_id}.json`);
    writeFileSync(file, JSON.stringify(job));
    if (!parked) await waitUntilGone(file);
  } else if (url.pathname.startsWith("/orders/") || url.pathname === "/reorders") {
    route = url.pathname === "/reorders" ? "/reorders" : "/orders/:id";
    const { side, gate } = quickReorder(url.searchParams.get("as") ?? "");
    emit({ trace, kind: "flag", id: newId(), parent: id, name: "quick_reorder", side, gate });
    if (url.pathname === "/reorders") status = side === "on" ? 201 : 403;
    else body = url.pathname === "/orders/404" ? "missing" : side === "on" ? "reorder" : "plain";
  } else if (url.pathname === "/switches") {
    switchedOn.add(url.searchParams.get("as") ?? "");
  } else if (url.pathname === "/receipts") {
    status = 202;
    const job = { trace, name: "ReceiptJob", queue: "default", job_id: newId(), not_before: Date.now() + 600 };
    emit({ trace, kind: "job", id: newId(), parent: id, name: job.name, queue: job.queue, phase: "enqueue", job_id: job.job_id });
    writeFileSync(path.join(jobs, `${job.job_id}.json`), JSON.stringify(job));
  } else if (url.pathname === "/spliced") {
    emitRaw(`{"trace":"${trace}","kind":"db",`);
    emit({ trace, kind: "flag", id: newId(), parent: id, name: "score_input_slider", side: "off" });
    emitRaw(`"table":"rooms","op":"read"}\n`);
  } else if (url.pathname === "/secret") {
    emit({ trace, kind: "db", id: newId(), parent: id, table: "admins", op: "read", rows: 1, x_note: `token ${process.env.ADMIN_TOKEN}` });
  } else if (url.pathname === "/lobby") {
    emit({ trace, kind: "db", id: newId(), parent: id, table: "rooms", op: "read", rows: 4 });
    emit({ trace, kind: "flag", id: newId(), parent: id, name: "score_input_slider", side: "off", gate: "boolean" });
    emit({ trace, kind: "db", id: newId(), parent: id, table: "events", op: "insert", rows: 1, committed: true });
  } else if (url.pathname === "/inlet") {
    body = JSON.stringify(inlet());
  }
  const line = { trace, kind: "request", id, method: req.method, route, status };
  if (url.pathname === "/up") emit(line);
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
  if (url.pathname === "/up") return;
  if (url.pathname === "/slow") {
    setTimeout(() => emit(line), 300);
    return;
  }
  if (url.pathname !== "/late") {
    emit(line);
    if (url.pathname === "/after") hold({ trace, kind: "db", id: newId(), parent: id, table: "scores", op: "insert", rows: 1, committed: true }, 500);
    return;
  }
  hold(line, 600);
}).listen(Number(process.env.PORT));
