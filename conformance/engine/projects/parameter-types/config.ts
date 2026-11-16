import { defineConfig } from "nukadoko";

export default defineConfig({
  parameterTypes: [
    { name: "priority", regexp: /高|低/, transformer: (s: string) => (s === "高" ? "high" : "low") },
    { name: "dueDay", regexp: /今日|明日/ },
  ],
});
