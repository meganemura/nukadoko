import { setWorldConstructor, World } from "../steps/runtime.js";

// Holds the one piece of state this suite's steps pass between each other:
// the outcome of the `nuka run` subprocess the When step spawns against the
// INNER fixture project (selftest-suite/fixture-project, see
// run-selftest.mjs's header comment for the inner/outer distinction). No
// constructor override: the base World's single-argument constructor is
// inherited as-is, same as tests/fixtures/compat-world-project's
// CustomWorld.
export class SelftestWorld extends World {
  nukaExitCode: number | null = null;
  nukaStdout = "";
}

setWorldConstructor(SelftestWorld);
