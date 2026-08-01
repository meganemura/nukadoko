import { defineConfig } from "./nukadoko-shim.js";

// Placeholder baseURL: tests/secrets.test.ts overwrites this file in the
// copied temp directory with the real ephemeral port (and whichever
// `secrets.public` a given test case needs) before running, since the real
// port is only known at test run time — same pattern as
// fixtures/session-project.
export default defineConfig({
  baseURL: "http://127.0.0.1:1",
  envFiles: [".env.secret"],
});
