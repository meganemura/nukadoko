import { defineConfig } from "./nukadoko-shim.js";

// Two named environments (nukadoko.program.ts) whose `version` probe either
// succeeds or always throws. tests/fixtures/environments-project already
// exercises both shapes through `nuka do` (tests/environment.test.ts), but
// this one drives them through `nuka run`'s own setup phase (cli/run.ts's
// own probeVersion() call), which is a separate call site from cli/do.ts's.
export default defineConfig({});
