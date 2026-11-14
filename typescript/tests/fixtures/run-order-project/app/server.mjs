import { createServer } from "node:http";

// Accounts live in this process's memory for as long as the world runs.
// `POST /accounts/<name>` adds one, `GET /accounts` lists them, and
// `POST /sessions/<name>` answers 200 for an account that exists and 404
// for one that does not.
const accounts = new Set();
createServer((req, res) => {
  const [, collection, name] = (req.url ?? "").split("/");
  let status = 404;
  let body = {};
  if (req.method === "GET" && collection === "accounts" && name === undefined) {
    status = 200;
    body = { names: [...accounts] };
  } else if (req.method === "POST" && collection === "accounts" && name) {
    accounts.add(name);
    status = 201;
  } else if (req.method === "POST" && collection === "sessions" && name) {
    status = accounts.has(name) ? 200 : 404;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(Number(process.env.PORT));
