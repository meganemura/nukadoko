// The program under test for failures underneath, in both engines. Every
// POST under /ask writes its request line. /ask/down answers 503,
// /ask/boom reports an error nothing handled and answers 200,
// /ask/caught reports one it handled, and /ask/ok only answers. GET
// /page/throw is a page whose script throws a TypeError nothing catches,
// and /page/down a page that asks /ask/down itself; each sets its title
// to "done" once it is.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const events = process.argv[3];
const write = (line) => appendFileSync(events, `${JSON.stringify(line)}\n`);

createServer((request, response) => {
  const trace = request.headers.traceparent;
  if (request.url === "/up") return response.end("up");
  if (request.method === "GET" && request.url === "/page/throw") {
    response.setHeader("content-type", "text/html");
    return response.end('<title>loading</title><script>throw new TypeError("no shelf")</script><script>document.title = "done"</script>');
  }
  if (request.method === "GET" && request.url === "/page/down") {
    response.setHeader("content-type", "text/html");
    return response.end('<title>loading</title><script>fetch("/ask/down", { method: "POST" }).then(() => { document.title = "done"; })</script>');
  }
  if (request.method === "POST" && request.url.startsWith("/ask/")) {
    const what = request.url.slice("/ask/".length);
    if (what === "boom") write({ trace, kind: "error", class: "Boom", handled: false });
    if (what === "caught") write({ trace, kind: "error", class: "Boom", handled: true });
    const status = what === "down" ? 503 : 200;
    write({ trace, kind: "request", method: "POST", route: "/ask/:what", status });
    response.statusCode = status;
    return response.end(what);
  }
  response.statusCode = 404;
  response.end();
}).listen(Number(process.argv[2]));
