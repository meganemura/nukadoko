import { defineStep } from "nukadoko";
import { z } from "zod";

// No `pattern`, no `patterns`: valid CLI-only vocabulary
// (src/step/define-step.ts's `StepDefinitionInput`, both fields optional).
// tests/extraction/step-extraction.test.ts's own "nothing to extract,
// nothing wrong either" fixture.
export default defineStep({
  description: "CLI-only vocabulary, never bound to a Gherkin line",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
