import { mkdirSync, readFileSync } from "node:fs";
import { AfterAll, BeforeAll } from "../../nukadoko-compat-shim.js";

// Responsibility: run hooks a test makes fail on purpose, through
// hooks.json at the project root, which a test writes: `afterAll: true`
// fails every AfterAll, and `beforeAll: [n, ...]` fails the BeforeAll calls
// with those numbers. Calls are counted across every process of the run
// in .hookcount/, so a test can fail the BeforeAll of one pass, or of the
// worker one proof round starts. A file, not an env var, so a worker
// process reads the same switch as the parent without the test changing
// its own environment.
interface Switches {
  readonly afterAll?: boolean;
  readonly beforeAll?: readonly number[];
}

function switches(): Switches {
  try {
    return JSON.parse(readFileSync(new URL("../../hooks.json", import.meta.url), "utf8")) as Switches;
  } catch {
    return {};
  }
}

BeforeAll(function () {
  const base = new URL("../../.hookcount/", import.meta.url);
  mkdirSync(base, { recursive: true });
  let call = 1;
  for (;;) {
    try {
      mkdirSync(new URL(String(call), base));
      break;
    } catch {
      call += 1;
    }
  }
  if ((switches().beforeAll ?? []).includes(call)) throw new Error(`BeforeAll call ${call} fails`);
});

AfterAll(function () {
  if (switches().afterAll === true) throw new Error("AfterAll fails");
});
