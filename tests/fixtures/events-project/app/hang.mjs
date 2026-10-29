import { spawn } from "node:child_process";

// A command-line tool that never ends, with a helper that holds its
// output open: stopping the tool alone would leave the helper, and the
// output never closes. It prints the helper's pid first.
const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
process.stdout.write(String(helper.pid));
setTimeout(() => {}, 60000);
