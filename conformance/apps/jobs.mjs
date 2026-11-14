// Jobs that finish a little after they start: POST /jobs starts one, and
// GET /jobs/:id answers "running" until it ends "done" or "failed". A Then
// that reads the status has to wait for it, which is what poll is for.
import http from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const jobs = new Map();

http
  .createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/jobs" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { name, ends } = JSON.parse(body);
      const id = String(jobs.size + 1);
      jobs.set(id, { id, name, status: "running" });
      setTimeout(() => (jobs.get(id).status = ends), 400);
      return send(201, jobs.get(id));
    }
    const match = req.url.match(/^\/jobs\/(\w+)$/);
    if (match && jobs.has(match[1])) return send(200, jobs.get(match[1]));
    if (req.url === "/jobs") return send(200, [...jobs.values()]);
    send(404, { error: "not found" });
  })
  .listen(port, "127.0.0.1");
