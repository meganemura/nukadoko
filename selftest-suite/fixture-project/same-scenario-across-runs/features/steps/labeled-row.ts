import { z } from "zod";
import { defineStep } from "nukadoko";

// Responsibility: outline.feature's own single step -- deliberately static
// text (the Examples table's own "label" column is never interpolated into
// it, outline.feature's own header explains why), so nothing about a
// step's own record tells the two rows apart. Always passes: this fixture
// exists to prove the two rows are recognised as two distinct scenarios by
// nukadoko's own scenario-level identity, not to exercise pass/fail
// behavior (toggle.feature already does that).
export default defineStep({
  pattern: "a row that always passes",
  description: "Always passes; only the Examples table tells the two rows apart",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
