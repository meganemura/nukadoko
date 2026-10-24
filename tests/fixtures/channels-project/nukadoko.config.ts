import { defineConfig } from "./nukadoko-shim.js";

// No browser and no server of its own: the test starts the echo server and
// names it in CHANNELS_BASE. `.env` supplies the secret one step sends.
export default defineConfig({
  envFiles: [".env"],
});
