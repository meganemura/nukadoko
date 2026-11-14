import { defineStep, z } from "nukadoko";
import keepNote from "./keep-note.ts";

export default defineStep({
  description: "The kept note",
  pattern: "the kept note is a string",
  args: z.object({ kept: z.string().describe("The kept note"), text: z.string().describe("What the line says") }),
  from: { kept: [keepNote, "note"] },
  claims: [{ actual: "kept", compare: "is-a", expected: { literal: "string" } }],
});
