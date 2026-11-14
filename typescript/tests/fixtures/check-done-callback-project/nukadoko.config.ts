import { defineConfig } from "./nukadoko-shim.js";

// Done-callback glue that `nuka run` already refuses. `nuka check` must
// refuse it too: the arity is known from the function and, for a step,
// from the matched line, before anything runs.
export default defineConfig({});
