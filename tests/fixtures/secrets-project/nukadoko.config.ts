import { defineConfig } from "./nukadoko-shim.js";

// tests/secrets.test.ts overwrites this file in the copied temp directory
// (with whichever `secrets.public` a given test case needs), and writes a
// nukadoko.program.ts whose url is its ephemeral echo server, before
// running, since the real port is only known at test run time.
export default defineConfig({
  envFiles: [".env.secret"],
});
