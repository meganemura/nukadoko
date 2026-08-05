import { defineConfig } from "./nukadoko-shim.js";

// p10-step-discovery task spec, scope 3: a project with one real .ts step
// (so the vocabulary is not empty and no-step-files-found stays out of this
// fixture's own way) plus one .cjs file discovery walks but never imports.
// `nuka check` must name the .cjs file (step-file-unsupported-extension)
// rather than letting whatever it might have defined resurface as an
// unexplained undefined-step.
export default defineConfig({});
