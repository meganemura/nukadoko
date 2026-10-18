import { defineConfig } from "nukadoko";

// Local-only example: baseURL points at the todo app you start yourself
// (see README.md) -- there is no envFiles entry because this app needs no
// secrets to talk to.
export default defineConfig({
  baseURL: "http://localhost:4000",
});
