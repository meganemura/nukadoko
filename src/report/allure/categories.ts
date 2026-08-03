import { Status } from "allure-js-commons";
import type { Category } from "allure-js-commons/sdk";
import type { ErrorKind } from "../../receipt/types.js";
import { buildFailureMarker, statusForKind } from "./map-scenario.js";

// Responsibility: the run-wide categories.json (this task's spec, decision
// 4) — one rule per `ErrorKind`, always all of them, written once at the
// start of a run (the content never depends on how the run goes, so there's
// no reason to wait until it finishes). Each rule's own `matchedStatuses`/
// marker format comes from map-scenario.ts's own `statusForKind`/
// `buildFailureMarker` rather than a second copy of that
// table here — the categories.json regex and the message map-scenario.ts
// actually writes into `statusDetails.message` must never drift apart, and
// importing the single source of truth is cheaper than a test that only
// catches drift after the fact (map-scenario.ts itself has no reason to
// import this module back: building actual allure-js `Category`/`Status`
// values is exactly the allure-js dependency map-scenario.ts's own header
// explains staying free of).

const ERROR_KINDS: readonly ErrorKind[] = [
  "args_invalid",
  "result_invalid",
  "binding_invalid",
  "world_invalid",
  "timeout",
  "unsupported",
  "step_error",
];

// One human-readable classification name per kind. Only the first four carry
// the "Contract: ..." register — they are failures the contract layer
// itself can name (README's own Tier A); the remaining three are not: a
// timeout/unsupported-shape/step_error is a vocabulary or execution defect
// the contract layer never got to judge, so each gets its own distinct name
// instead of the same "Contract: ..." register.
const NAME_BY_KIND: Readonly<Record<ErrorKind, string>> = {
  args_invalid: "Contract: args failed the step's schema",
  result_invalid: "Contract: result failed the step's schema",
  binding_invalid: "Contract: the step's text couldn't bind",
  world_invalid: "Contract: a World key's write failed its schema",
  timeout: "Timeout",
  unsupported: "Compat: unsupported step shape",
  step_error: "Step error",
};

// allure-js-commons' own `escapeRegExp` (dist/cjs/sdk/reporter/utils.js) is
// not part of the package's public exports (verified against allure-js-
// commons' own exports) — a small reimplementation here is unavoidable, not
// a rejection of "don't reimplement the SDK".
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One rule per `ErrorKind`, Allure 2's "first rule wins, full-text,
 * DOTALL" regex format (this task's spec, decision 4). Order follows
 * `ErrorKind`'s own declaration order in receipt/types.ts — the regexes are
 * mutually exclusive by construction (each matches only messages carrying
 * that exact kind's own marker), so the order has no effect on matching,
 * only on readability. */
export function buildCategories(): Category[] {
  return ERROR_KINDS.map((kind) => ({
    name: NAME_BY_KIND[kind],
    matchedStatuses: [statusForKind(kind) === "failed" ? Status.FAILED : Status.BROKEN],
    messageRegex: `${escapeRegExp(buildFailureMarker(kind))}[\\s\\S]*`,
  }));
}
