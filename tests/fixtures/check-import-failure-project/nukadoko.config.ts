import { defineConfig } from "./nukadoko-shim.js";

// m21a-compat-gap-detect task spec: a project with exactly one glue file
// that fails to import, and one feature that uses the step that file would
// otherwise have registered — `nuka check` must report the import failure
// itself (`step-file-import-failed`), suppress the `undefined-step` that
// step would otherwise produce, and say so (`undefined-step-check-
// suppressed`) instead of silently dropping it.
export default defineConfig({});
