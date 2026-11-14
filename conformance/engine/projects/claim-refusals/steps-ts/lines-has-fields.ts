import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A refused claim",
  pattern: "the log has fields {fields:string}",
  args: z.object({ fields: z.string().describe("The fields") }),
  observe() {
    return {};
  },
  claims: [{ actual: "log", view: "lines", compare: "has-fields", expected: "fields", expected_view: "json" }],
});
