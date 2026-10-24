// A small items API on node:http, listening on PORT. Its items live in
// memory for as long as the process runs. Each request's log line starts
// with the traceparent nukadoko puts on it, so each step record holds the
// server's lines for that step's requests. GET /items/count answers only
// when ITEM_COUNT is 1, the way a feature behind a switch does while it
// rolls out; without it, the path is an unknown id.
import { createServer } from "node:http";

const items = new Map<number, { id: number; name: string }>();
let nextId = 1;

createServer(async (req, res) => {
  console.log(`[${req.headers.traceparent ?? "-"}] ${req.method} ${req.url}`);
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/items") return send(200, [...items.values()]);
  if (req.method === "GET" && url.pathname === "/items/count" && process.env.ITEM_COUNT === "1") return send(200, { count: items.size });
  const m = url.pathname.match(/^\/items\/(\d+)$/);
  if (req.method === "GET" && m) {
    const item = items.get(Number(m[1]));
    return item ? send(200, item) : send(404, { error: "not found" });
  }
  if (req.method === "POST" && url.pathname === "/items") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: { name?: unknown };
    try { body = JSON.parse(raw); } catch { return send(400, { error: "body is not JSON" }); }
    if (typeof body.name !== "string" || body.name === "") return send(422, { error: "name is required" });
    const item = { id: nextId++, name: body.name };
    items.set(item.id, item);
    return send(201, item);
  }
  send(404, { error: "not found" });
}).listen(Number(process.env.PORT));
