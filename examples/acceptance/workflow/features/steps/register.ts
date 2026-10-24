import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Submit a registration; returns the outcome, never throws on refusal",
  pattern: "a registration for {email:string} with password {password:string} is submitted",
  args: z.object({
    email: z.string().describe("The email registered"),
    password: z.string().describe("The password chosen"),
  }),
  returns: z.object({
    outcome: z.enum(["accepted", "refused"]).describe("Whether the registration was accepted or refused"),
    token: z.string().nullable().describe("The confirmation token issued, when accepted"),
    reason: z.string().nullable().describe("Why it was refused, when refused"),
  }),
  run({ store }, { email, password }) {
    const r = store.register(email, password);
    return r.ok
      ? { outcome: "accepted" as const, token: r.token, reason: null }
      : { outcome: "refused" as const, token: null, reason: r.reason };
  },
});
