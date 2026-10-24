import { createServer } from "node:http";

// Answers with what its process got, and prints its token, so a test sees
// the world's env reach the program and the token leave no record.
console.log(`listening with token ${process.env.TOKEN}`);
createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: req.url, db: process.env.DB, token: process.env.TOKEN }));
}).listen(Number(process.env.PORT));
