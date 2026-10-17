import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Attempt a sign-in; returns the outcome, never throws on refusal",
  pattern: "{email:string} signs in with password {password:string}",
  args: z.object({
    email: z.string().describe("The email used"),
    password: z.string().describe("The password used"),
  }),
  returns: z.object({
    accepted: z.boolean().describe("Whether the sign-in was accepted"),
    reason: z.string().nullable().describe("Why it was refused, when refused"),
  }),
  mutates: false,
  run({ store }, { email, password }) {
    const r = store.signIn(email, password);
    return r.ok ? { accepted: true, reason: null } : { accepted: false, reason: r.reason };
  },
});
