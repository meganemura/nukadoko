import { defineStep, z } from "nukadoko";

/** The name of the error `call` throws, or undefined when it threw none. */
async function thrownBy(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

export default defineStep({
  description: "Open a page for aki and one for ben",
  pattern: "aki and ben each open a page",
  args: z.object({}),
  // Keeps nothing.
  mutates: false,
  async run({ pageAs, context }) {
    const aki = await pageAs("aki");
    const ben = await pageAs("ben", { javaScriptEnabled: false });
    if (aki.context() === ben.context() || aki.context() === context) throw new Error("same context");
    if ((await pageAs("aki")) !== aki) throw new Error("not the same page");
    if ((await thrownBy(() => pageAs("ben", { javaScriptEnabled: true }))) !== "ContextOptionsConflictError") throw new Error("no conflict");
    if ((await thrownBy(() => pageAs("Aki"))) !== "InvalidContextNameError") throw new Error("no name error");
    await aki.setContent("<p>aki</p>");
  },
});
