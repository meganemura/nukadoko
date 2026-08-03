import { defineConfig } from "./nukadoko-shim.js";

// m7b-unfillable-key task spec's own fixture: a pure-step project, same
// rationale as from-project's own (no browser/HTTP anywhere) — every
// scenario here is about the static "can this required args key ever be
// filled" question, not evidence collection.
export default defineConfig({});
