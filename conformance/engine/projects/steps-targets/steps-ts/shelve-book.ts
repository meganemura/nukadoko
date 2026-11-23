import { defineStep, z } from "nukadoko";
import placeBook from "./parts/place-book.ts";

export default defineStep({
  description: "Put a book on the shelf, through one part",
  pattern: "a book titled {title:string} is shelved",
  args: z.object({ title: z.string().describe("The title of the book") }),
  mutates: true,
  parts: [placeBook],
  async run({ call }, args) {
    await call(placeBook, { title: args.title });
    return {};
  },
});
