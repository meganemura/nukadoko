import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

// A command that runs until a signal stops it, with a helper in its
// process group that does the same. Each appends its pid to `pids` and the
// signal it got to `signals.txt`, in the directory given; the leader
// writes `ready` once the helper listens.
const dir = process.argv[2];
const helper = process.argv[3] === "helper";
const who = helper ? "helper" : "leader";
appendFileSync(path.join(dir, "pids"), `${process.pid}\n`);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    appendFileSync(path.join(dir, "signals.txt"), `${who} ${signal}\n`);
    process.exit(0);
  });
}
if (helper) {
  writeFileSync(path.join(dir, "helper-ready"), "");
} else {
  spawn(process.execPath, [process.argv[1], dir, "helper"], { stdio: "inherit" });
  const wait = setInterval(() => {
    if (!existsSync(path.join(dir, "helper-ready"))) return;
    clearInterval(wait);
    writeFileSync(path.join(dir, "ready"), "");
  }, 10);
}
setTimeout(() => {}, 60_000);
