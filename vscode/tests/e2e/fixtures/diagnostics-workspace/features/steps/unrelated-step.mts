import { defineStep } from "nukadoko";
import { z } from "zod";

// Present only so `nuka check` finds at least one real step file (an empty
// vocabulary reports its own "no-step-files-found" error, which would blur
// this fixture's one intended issue). This step's own pattern is
// deliberately unrelated to features/todo.feature's step text, so that
// feature's step still resolves to nothing -- the undefined-step issue
// tests/e2e/diagnostics-command.test.ts looks for. .mts for the same reason
// nukadoko.config.mts (this fixture's sibling) is .mts, not .ts: a plain
// .ts file here would load as CommonJS (vscode/package.json has no "type":
// "module") and fail to resolve its own `import ... from "nukadoko"`.
export default defineStep({
  pattern: "an unrelated step exists",
  description: "unrelated to the fixture's own undefined step",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
