import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

// `/broken` answers 500 and reports the error that ended it, with
// handled: false. `/down` answers 503 and reports nothing. `/stale`
// answers 200 and reports an error with handled: false, as a request
// that failed after its answer went out does. `/rescued` answers 200 and
// reports an error it caught, with handled: true. Every request's line
// goes out after the lines of what happened inside it.
const EVENTS = process.env.EXECUTION_EVENTS;
const newId = () => randomBytes(8).toString("hex");
const emit = (line) => {
  if (EVENTS !== undefined) appendFileSync(EVENTS, `${JSON.stringify(line)}\n`);
};

createServer((req, res) => {
  const trace = req.headers.traceparent ?? `00-${randomBytes(16).toString("hex")}-${newId()}-01`;
  const route = new URL(req.url, "http://localhost").pathname;
  const id = newId();
  let status = 200;
  if (route === "/broken") {
    status = 500;
    emit({ trace, kind: "error", id: newId(), parent: id, class: "Boom::Exploded", handled: false });
  } else if (route === "/down") {
    status = 503;
  } else if (route === "/stale") {
    emit({ trace, kind: "error", id: newId(), parent: id, class: "Ledger::Stale", handled: false });
  } else if (route === "/rescued") {
    emit({ trace, kind: "error", id: newId(), parent: id, class: "Ledger::Stale", handled: true });
  }
  emit({ trace, kind: "request", id, method: req.method, route, status });
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(String(status));
}).listen(Number(process.env.PORT));
