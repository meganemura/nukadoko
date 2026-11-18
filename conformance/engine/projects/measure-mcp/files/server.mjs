// The MCP server under test, in both engines: JSON-RPC over POST /mcp,
// one message a request. Each request writes its request line with the
// traceparent header it came with. tools/call answers whether that header
// is the traceparent in the call's params._meta: "same", "different", or
// "none" when the header is missing. The tool "broken" answers with
// isError, and a method it does not know with a JSON-RPC error. A
// notification is answered 202 with no body.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const events = process.argv[3];
const write = (line) => appendFileSync(events, `${JSON.stringify(line)}\n`);

createServer((request, response) => {
  if (request.url === "/up") return response.end("up");
  if (request.method !== "POST" || request.url !== "/mcp") {
    response.statusCode = 404;
    return response.end();
  }
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const trace = request.headers.traceparent;
    const message = JSON.parse(body);
    const status = message.id === undefined ? 202 : 200;
    write({ trace, kind: "request", method: "POST", route: "/mcp", status });
    response.statusCode = status;
    if (message.id === undefined) return response.end();
    response.setHeader("content-type", "application/json");
    const meta = message.params?._meta?.traceparent;
    const seen = trace === undefined ? "none" : trace === meta ? "same" : "different";
    if (message.method !== "tools/call") {
      return response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}\nat the server` } }));
    }
    const broken = message.params.name === "broken";
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: seen }], ...(broken ? { isError: true } : {}) } }));
  });
}).listen(Number(process.argv[2]));
