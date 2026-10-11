import { writeFileSync } from "node:fs";

// A server that answers `initialize` with an error and then stays up.
// Exiting here would hide the leak: a process that ends on its own is
// already gone when `connectMcpServer` rejects. The handshake catch this
// exists to reach is the same one a server that never writes takes, after
// the client package's own request timeout. Refusing outright keeps that
// catch, without sitting out the 60s default.

const pidFile = process.env.NUKA_PID_FILE;
if (pidFile === undefined || pidFile === "") {
  throw new Error("NUKA_PID_FILE is required");
}
writeFileSync(pidFile, String(process.pid));

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      nl = buf.indexOf("\n");
      continue;
    }
    if (msg.method === "initialize") {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: "handshake refused" },
        })}\n`,
      );
    }
    nl = buf.indexOf("\n");
  }
});

setInterval(() => {}, 1_000_000);
