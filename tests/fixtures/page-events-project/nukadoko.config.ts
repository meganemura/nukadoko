import { defineConfig } from "./nukadoko-shim.js";

// No baseURL: every step here reaches the browser only (ctx.page()), never
// ctx.request(), and the one URL a step visits (an unreachable local port,
// for the requestfailed case) is absolute already.
export default defineConfig({
  envFiles: [".env.secret"],
});
