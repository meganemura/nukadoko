import { defineConfig } from "nukadoko";

export default defineConfig({
  parameterTypes: [{ name: "word", regexp: /[a-z]+/ }],
});
