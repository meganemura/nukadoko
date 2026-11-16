import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Aki's page still shows aki",
  pattern: "aki's page is still aki's",
  args: z.object({}),
  // Keeps nothing.
  mutates: false,
  async run({ pageAs }) {
    if ((await (await pageAs("aki")).textContent("p")) !== "aki") throw new Error("lost");
  },
});
