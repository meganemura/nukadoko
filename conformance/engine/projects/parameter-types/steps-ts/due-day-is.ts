import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "The due day is the day the line gives",
  pattern: "期限は{day:dueDay}である",
  args: z.object({ day: z.string().describe("The day the line gives") }),
  observe() {
    return { due: "明日" };
  },
  claims: [{ actual: "due", compare: "equal", expected: "day" }],
});
