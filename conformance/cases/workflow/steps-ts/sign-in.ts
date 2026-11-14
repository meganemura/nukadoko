import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Attempt a sign-in; returns the outcome, never throws on refusal",
  pattern: "{email:string} signs in with password {password:string}",
  args: z.object({
    email: z.string().describe("The email used"),
    password: z.string().describe("The password used"),
  }),
  returns: z.object({
    outcome: z.enum(["accepted", "refused"]).describe("Whether the sign-in was accepted or refused"),
    reason: z.string().nullable().describe("Why it was refused, when refused"),
  }),
  mutates: false,
  run({ store }, { email, password }) {
    const r = store.signIn(email, password);
    return r.ok ? { outcome: "accepted" as const, reason: null } : { outcome: "refused" as const, reason: r.reason };
  },
});
