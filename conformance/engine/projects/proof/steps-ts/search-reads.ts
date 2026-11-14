import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The world's SEARCH variable reads the given text",
  pattern: "the search reads {value:string}",
  args: z.object({ value: z.string().describe("The text SEARCH holds") }),
  observe({ env }) {
    return { search: env.SEARCH ?? "" };
  },
  claims: [{ actual: "search", compare: "equal", expected: "value" }],
});
