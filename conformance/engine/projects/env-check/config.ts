import { defineConfig } from "nukadoko";

export default defineConfig({
  envFiles: ["shared.env", "gone.env"],
  secrets: { public: ["NOPE"], redact: ["API_TOKEN", "MISSING"] },
});
