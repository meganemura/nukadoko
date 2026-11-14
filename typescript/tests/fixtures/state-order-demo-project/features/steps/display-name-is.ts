import { defineStep, z } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{person:word}'s display name is {name:string}",
  description: "The display name the settings page shows",
  args: z.object({
    person: z.string().describe("The person whose settings are open"),
    name: z.string().describe("The display name the line expects"),
  }),
  requires: [["signed-in", "person"]],
  observe: ({}, { person }) => ({ displayName: person }),
  claims: [{ actual: "displayName", compare: "equal", expected: "name" }],
});
