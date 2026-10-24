import { createServer } from "node:http";

// Prints one line for each request, tagged with the request's
// `traceparent` the way docs/spec.md "Program" shows a program doing it.
// `TAG=none` prints no tag, as a program that does not tag its lines.
// `/trace-only` is always tagged with the trace id alone, as a program
// that tags a line only per request.
function tag(req) {
  const value = req.headers.traceparent;
  if (value === undefined) return "";
  if (req.url === "/trace-only") return `[trace=${value.split("-")[1]}] `;
  return process.env.TAG === "none" ? "" : `[${value}] `;
}

console.log("listening");
createServer((req, res) => {
  console.log(`${tag(req)}${req.method} ${req.url}`);
  if (req.url === "/page") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<script>fetch("/from-page").then(() => { document.title = "done"; })</script>');
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: req.url }));
}).listen(Number(process.env.PORT));
