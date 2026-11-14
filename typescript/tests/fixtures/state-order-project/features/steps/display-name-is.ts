import { defineStep, z } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{person:word}'s display name is {name:string}",
  args: z.object({ person: z.string(), name: z.string() }),
  requires: [["signed-in", "person"]],
  observe: ({}, { person }) => ({ displayName: person }),
  claims: [{ actual: "displayName", compare: "equal", expected: "name" }],
});
