import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The attachment `name` embeds the project's own secret env value — proves
// redaction reaches `evidence.attachments[].name`/`.file` on the step record
// (P9 task spec, test bullet 7), through the same single `redact()` call
// site every other step record field already goes through, no second
// redaction path of its own. The attachment's own *content* is
// deliberately not a secret here: this test is about the step record's JSON,
// never about file bytes (P9 task spec, scope item 4: file contents are
// never redacted).
export default defineStep({
  pattern: "a step attaches a name built from a secret",
  description: "Builds an attachment name from env.API_TOKEN",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ evidence, requireEnv }) {
    const token = requireEnv("API_TOKEN");
    await evidence.attach(`token-${token}.txt`, "irrelevant body");
    return { ok: true };
  },
});
