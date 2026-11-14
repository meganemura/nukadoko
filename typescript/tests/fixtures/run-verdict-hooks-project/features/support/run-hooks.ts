import { mkdirSync, readFileSync } from "node:fs";
import { AfterAll, BeforeAll } from "../../nukadoko-compat-shim.js";

// Responsibility: run hooks a test makes fail on purpose, through
// hooks.json at the project root, which a test writes: `afterAll: true`
// fails every AfterAll, and `beforeAll` and `afterAll` as lists of numbers
// fail the calls with those numbers. Calls are counted across every
// process of the run in a directory per hook, so a test can fail the hook
// of one pass, or of the worker one proof round starts. A file, not an env
// var, so a worker process reads the same switch as the parent without
// the test changing its own environment.
interface Switches {
  readonly afterAll?: boolean | readonly number[];
  readonly beforeAll?: readonly number[];
}

function switches(): Switches {
  try {
    return JSON.parse(readFileSync(new URL("../../hooks.json", import.meta.url), "utf8")) as Switches;
  } catch {
    return {};
  }
}

/** This call's number among every call of the hook so far, from 1. */
function callNumber(hook: string): number {
  const base = new URL(`../../.hookcount/${hook}/`, import.meta.url);
  mkdirSync(base, { recursive: true });
  for (let call = 1; ; call += 1) {
    try {
      mkdirSync(new URL(String(call), base));
      return call;
    } catch {
      // Taken by an earlier call.
    }
  }
}

BeforeAll(function () {
  const call = callNumber("before-all");
  if ((switches().beforeAll ?? []).includes(call)) throw new Error(`BeforeAll call ${call} fails`);
});

AfterAll(function () {
  const call = callNumber("after-all");
  const failing = switches().afterAll;
  if (failing === true || (Array.isArray(failing) && failing.includes(call))) throw new Error(`AfterAll call ${call} fails`);
});
