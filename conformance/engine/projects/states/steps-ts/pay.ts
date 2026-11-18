import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A person pays for an open book",
  pattern: "{person:word} pays",
  args: z.object({ person: z.string().describe("Who pays") }),
  requires: ["book-open", "paid"],
  mutates: false,
  run() {},
});
