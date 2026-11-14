import { AfterAll } from "../../nukadoko-compat-shim.js";

// Fails the run after every scenario passed, only when the test asks.
AfterAll(function () {
  if (process.env.NUKA_AFTERALL_FAIL === "1") throw new Error("teardown failed on purpose");
});
