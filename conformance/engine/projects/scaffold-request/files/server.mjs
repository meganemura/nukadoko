// The program under test for a --request step, in both engines: GET
// /greet/<name> answers with a greeting, POST /echo with its own body.
import { createServer } from "node:http";

createServer((request, response) => {
  const greet = /^\/greet\/([^/]+)$/.exec(request.url ?? "");
  if (request.method === "GET" && greet) return response.end(`Hello, ${decodeURIComponent(greet[1])}!`);
  if (request.method === "POST" && request.url === "/echo") return request.pipe(response);
  if (request.url === "/up") return response.end("up");
  response.statusCode = 404;
  response.end();
}).listen(Number(process.argv[2]));
