import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import { createServer } from "node:http";

// Tags each line with the request's trace id and a span id of the
// server's own, never the caller's. `/slow` writes its last line 400 ms
// after it answered, longer than a step waits for one. `BUFFERED=1` holds
// every line until the program is told to stop.
const pending = [];
const write = (line) => {
  if (process.env.BUFFERED === "1") pending.push(line);
  else console.log(line);
};
process.on("SIGTERM", () => {
  if (pending.length > 0) writeSync(1, pending.map((line) => `${line}\n`).join(""));
  process.exit(0);
});

createServer((req, res) => {
  const traceparent = req.headers.traceparent;
  const trace = traceparent === undefined ? "-" : traceparent.split("-")[1];
  const log = (text) => write(`trace_id=${trace} span_id=${randomBytes(8).toString("hex")} ${text}`);
  log(`started ${req.method} ${req.url}`);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
  if (req.url === "/slow") setTimeout(() => log(`completed ${req.url}`), 400);
  else log(`completed ${req.url}`);
}).listen(Number(process.env.PORT));
