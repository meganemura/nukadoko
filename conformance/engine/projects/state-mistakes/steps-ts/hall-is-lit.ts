import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The hall shows light",
  pattern: "the hall shows light",
  args: z.object({ light: z.string().describe("What the hall shows").optional() }),
  // @ts-expect-error a claim step leaves no state
  gives: ["lit"],
  claims: [{ actual: "light", compare: "equal", expected: { literal: "on" } }],
  observe() {
    return { light: "on" };
  },
});
