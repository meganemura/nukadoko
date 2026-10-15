import { runCommand } from "../../nukadoko-shim.js";
import { Given } from "../../nukadoko-compat-shim.js";

Given("a compat step runs a command", async function () {
  const { exitCode } = await runCommand(process.execPath, ["-e", "process.exit(0)"]);
  if (exitCode !== 0) throw new Error(`expected exit 0, got ${exitCode}`);
});
