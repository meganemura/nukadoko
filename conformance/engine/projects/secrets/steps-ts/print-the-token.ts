import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Print API_TOKEN from the env fixture, as project code that logs a value does",
  pattern: "I print the token",
  args: z.object({}),
  // Prints only.
  mutates: false,
  run({ env }) {
    console.log(`token is ${env.API_TOKEN}`);
  },
});
