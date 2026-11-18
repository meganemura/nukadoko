// The program under test for compared paths, in both engines. It runs
// with QUICK_REORDER true or false, the condition its two environments
// differ in. POST /items adds an item and, with the reorder on, moves
// its position too. POST /peek writes a visit, a bookkeeping table, once
// with the reorder off and twice with it on. POST /list writes nothing
// but its request line, the same on both sides. POST /mail enqueues one
// mail job with the reorder off and two with it on, which never perform,
// so the trace is not whole. POST /orders refuses with 409 when the
// reorder is on.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const events = process.argv[3];
const quick = process.env.QUICK_REORDER === "true";
const write = (line) => appendFileSync(events, `${JSON.stringify(line)}\n`);

createServer((request, response) => {
  const trace = request.headers.traceparent;
  if (request.url === "/up") return response.end("up");
  if (request.method === "POST" && request.url === "/items") {
    write({ trace, kind: "flag", name: "quick_reorder", side: quick ? "on" : "off", gate: "actor" });
    write({ trace, kind: "db", table: "items", op: "insert", rows: 1, committed: true });
    if (quick) write({ trace, kind: "db", table: "positions", op: "update", rows: 1, committed: true });
    write({ trace, kind: "request", method: "POST", route: "/items", status: 201 });
    response.statusCode = 201;
    return response.end("added");
  }
  if (request.method === "POST" && request.url === "/peek") {
    for (let i = 0; i < (quick ? 2 : 1); i += 1) write({ trace, kind: "db", table: "visits", op: "insert", rows: 1, committed: true });
    write({ trace, kind: "request", method: "POST", route: "/peek", status: 200 });
    return response.end("peeked");
  }
  if (request.method === "POST" && request.url === "/list") {
    write({ trace, kind: "request", method: "POST", route: "/list", status: 200 });
    return response.end("listed");
  }
  if (request.method === "POST" && request.url === "/mail") {
    for (let i = 0; i < (quick ? 2 : 1); i += 1) write({ trace, kind: "job", name: "Mail", phase: "enqueue", job_id: `${trace}-${i}` });
    write({ trace, kind: "request", method: "POST", route: "/mail", status: 202 });
    response.statusCode = 202;
    return response.end("queued");
  }
  if (request.method === "POST" && request.url === "/orders") {
    write({ trace, kind: "request", method: "POST", route: "/orders", status: quick ? 409 : 201 });
    response.statusCode = quick ? 409 : 201;
    return response.end();
  }
  response.statusCode = 404;
  response.end();
}).listen(Number(process.argv[2]));
