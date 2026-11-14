import { defineProgram } from "nukadoko";

// One world per engine. Every scenario runs once against each, so a
// behavior holds only when both engines show it.
export default defineProgram({
  defaultEnvironments: ["typescript", "ruby"],
  environments: {
    typescript: { env: { NUKA_ENGINE: "typescript" } },
    ruby: { env: { NUKA_ENGINE: "ruby" } },
  },
});
