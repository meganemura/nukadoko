import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Return two values the env files gave the env fixture",
  pattern: "I read the env",
  args: z.object({}),
  returns: z.object({
    token: z.string().describe("API_TOKEN, four characters or longer"),
    short: z.string().describe("SHORT, too short to redact"),
  }),
  // Reads the env fixture only.
  mutates: false,
  run({ env }) {
    return { token: env.API_TOKEN ?? "", short: env.SHORT ?? "" };
  },
});
