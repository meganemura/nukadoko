import { defineConfig } from "nukadoko";

export default defineConfig({
  parameterTypes: [
    { name: "priority", regexp: /高|低/, transformer: (s: string) => (s === "高" ? "high" : "low") },
    { name: "spare", regexp: /予備/ },
  ],
});
