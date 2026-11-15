import { defineStep, z } from "nukadoko";
import { started } from "./lib/started.ts";
import nukaStarts from "./nuka-starts.ts";

export default defineStep({
  description: "The nuka an earlier step started ends, within 60 seconds, with exactly this exit code",
  pattern: "the started nuka exits with {code:int}",
  args: z.object({
    code: z.number().describe("The expected exit code"),
    started: nukaStarts.returns.shape.started,
  }),
  from: { started: [nukaStarts, "started"] },
  async observe({}, { started: dir }) {
    const ran = started.get(dir);
    if (ran === undefined) throw new Error(`no nuka was started in ${dir}`);
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the started nuka did not end within 60 seconds")), 60_000).unref());
    const ended = await Promise.race([ran, timeout]);
    started.delete(dir);
    return { exitCode: ended.exitCode };
  },
  claims: [{ actual: "exitCode", compare: "equal", expected: "code" }],
});
