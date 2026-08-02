import { defineConfig } from "nukadoko";

// Local-only example, same shape as examples/todo/nukadoko.config.ts -- no
// envFiles entry because this app needs no secrets.
export default defineConfig({
  baseURL: "http://localhost:4000",
});
