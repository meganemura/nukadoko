import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A signed-in person opens a book",
  pattern: "{person:word} opens a book",
  args: z.object({ person: z.string().describe("Who opens it") }),
  requires: [["signed-in", "person"]],
  gives: ["book-open"],
  mutates: false,
  run() {},
});
