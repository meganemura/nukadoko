import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

// Answers with what its process got, and prints its token, so a test sees
// the world's env reach the program and the token leave no record. `/write`
// writes a file beside the database, as a program keeps its state.
console.log(`listening with token ${process.env.TOKEN}`);
createServer((req, res) => {
  if (req.url === "/write") writeFileSync(path.join(path.dirname(process.env.DB), "program-wrote.txt"), "from the program\n");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: req.url, db: process.env.DB, token: process.env.TOKEN }));
}).listen(Number(process.env.PORT));
