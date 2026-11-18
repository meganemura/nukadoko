// The program under test for execution events, in both engines. POST
// /items adds an item and appends what it did to the file {events} names,
// one db line and then its request line, each with the traceparent the
// request carried. POST /jobs enqueues a job that performs after the
// answer, so its perform line arrives after the step ended, and writes a
// line that is not JSON beside it. POST /slow-items answers at once and
// writes its lines 250 ms later, after a claim that waits less has read.
// POST /reorder/<side> evaluates a flag on that side, and POST /peek
// writes a visit, though the step that sends it declares it changes nothing.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const events = process.argv[3];
const write = (line) => appendFileSync(events, `${typeof line === "string" ? line : JSON.stringify(line)}\n`);

createServer((request, response) => {
  const trace = request.headers.traceparent;
  if (request.url === "/up") return response.end("up");
  if (request.method === "POST" && request.url === "/items") {
    write({ trace, kind: "db", table: "items", op: "insert", rows: 1, committed: true });
    write({ trace, kind: "request", method: "POST", route: "/items", status: 201 });
    response.statusCode = 201;
    return response.end("added");
  }
  if (request.method === "POST" && request.url.startsWith("/reorder/")) {
    write({ trace, kind: "flag", name: "quick_reorder", side: request.url.slice("/reorder/".length), gate: "actor" });
    write({ trace, kind: "request", method: "POST", route: "/reorder/:side", status: 200 });
    return response.end("evaluated");
  }
  if (request.method === "POST" && request.url === "/peek") {
    write({ trace, kind: "db", table: "visits", op: "insert", rows: 1, committed: true });
    write({ trace, kind: "request", method: "POST", route: "/peek", status: 200 });
    return response.end("peeked");
  }
  if (request.method === "POST" && request.url === "/slow-items") {
    setTimeout(() => {
      write({ trace, kind: "db", table: "items", op: "insert", rows: 1, committed: true });
      write({ trace, kind: "request", method: "POST", route: "/slow-items", status: 201 });
    }, 250);
    response.statusCode = 201;
    return response.end("added");
  }
  if (request.method === "POST" && request.url === "/jobs") {
    write({ trace, kind: "job", name: "Mail", phase: "enqueue", job_id: "j1" });
    write(`not json ${trace}`);
    write({ trace, kind: "request", method: "POST", route: "/jobs", status: 202 });
    setTimeout(() => write({ trace, kind: "job", name: "Mail", phase: "perform", job_id: "j1" }), 400);
    response.statusCode = 202;
    return response.end("queued");
  }
  response.statusCode = 404;
  response.end();
}).listen(Number(process.argv[2]));
