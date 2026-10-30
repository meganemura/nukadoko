import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { addNote, answer, emit, newId } from "./notes.mjs";

// The world: an MCP server over streamable HTTP at POST /mcp, answering
// each message with JSON, and POST /notes for the stdio server to call.
// Every line a request causes carries the traceparent the request arrived
// with, and the request's own line comes last, after its body is sent.
// `/up` answers before any line, so no step reads one of its lines.
const made = () => `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;

createServer(async (req, res) => {
  if (req.url === "/up") return void res.end("ok");
  const trace = req.headers.traceparent ?? made();
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (status, route, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload, () => emit({ trace, kind: "request", id: newId(), method: req.method, route, status }));
  };
  if (req.method === "POST" && req.url === "/mcp") {
    const reply = await answer(JSON.parse(body), (args) => addNote(args.text, trace));
    return send(reply === undefined ? 202 : 200, "/mcp", reply === undefined ? "" : JSON.stringify(reply));
  }
  if (req.method === "POST" && req.url === "/notes") return send(201, "/notes", JSON.stringify(addNote(JSON.parse(body).text, trace)));
  send(404, null, "{}");
}).listen(Number(process.env.PORT));
