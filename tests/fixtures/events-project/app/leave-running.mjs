import { spawn } from "node:child_process";

// A command-line tool that starts a helper and exits while the helper
// still runs: the helper keeps the tool's process group, with output of
// its own, so the tool's exit does not wait for it. It prints the
// helper's pid, and the helper exits after the milliseconds given.
const helper = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${Number(process.argv[2])})`], { stdio: "ignore" });
helper.unref();
process.stdout.write(String(helper.pid));
