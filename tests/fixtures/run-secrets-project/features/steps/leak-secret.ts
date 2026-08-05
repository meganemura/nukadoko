import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Throws with the secret env value inside its own message, on purpose: the
// message flows into both this step's failed receipt (error.message) and
// the owning scenario record's per-step error.message (this task's spec,
// scope item 4's redaction test) — proving redaction is applied to the
// scenario record as a whole, not only to receipts.
export default defineStep({
  pattern: "the secret leaks",
  description: "Throws with a secret value in its message to prove redaction reaches records too",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run({ env }) {
    throw new Error(`token leaked: ${env.API_TOKEN ?? "(missing)"}`);
  },
});
