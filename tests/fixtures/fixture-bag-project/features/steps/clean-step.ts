import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The well-formed control case: destructures two real fixtures (renamed
// `env` to `environment` — proves a rename, `{ env: environment }`, still
// extracts correctly, matching Playwright's own fixture-renaming behavior),
// no `nuka check`/`nuka run`/`nuka do` issue at all. This
// is also this fixture project's tsx-loaded regression case
// (tests/fixture-names.test.ts): a representative step loaded through the
// real discovery path, asserting `fixtureParameterNames` reads back exactly
// `["page", "env"]` for it.
export default defineStep({
  pattern: "a clean step runs",
  description: "Destructures page and a renamed env — the well-formed control case",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page, env: environment }) {
    await page.setContent(`<html><body>${environment.MISSING ?? "no-such-key"}</body></html>`);
    return { ok: true };
  },
});
