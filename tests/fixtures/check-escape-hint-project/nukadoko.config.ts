import { defineConfig } from "./nukadoko-shim.js";

// Reproduces the fineract/e-petitions validation-gate finding
// (.claude-team/validation/review-notes.md): a pattern's literal "(USD)"
// left unescaped is read by cucumber-expressions as an optional group, not
// literal parens, so it builds fine and then silently never matches pickle
// text that actually contains the parens. m1x-docs-check-fixes task spec,
// scope 2: `nuka check`'s undefined-step near-miss escape hint must fire for
// this case and must not fire for the unrelated undefined step alongside it.
export default defineConfig({});
