import type { Pickle } from "@cucumber/messages";
import type { z } from "zod";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { FixtureGraph } from "../fixture/graph.js";
import { stepNeeds } from "../fixture/step-needs.js";
import { isEachClaim, pathSegments, type Claim, type ClaimExpected, type ItemClaim } from "../step/claims.js";
import { isClaimStep, isStep, tryFromCandidates, type ClaimStep, type Step } from "../step/define-step.js";
import type { BoundStepLine, StepTextMatcher } from "./feature-check.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `nuka check` findings that need a claim step's line
// (docs/spec.md "Claims"). Where each side of a claim comes from depends on
// which earlier line produced a `from` value, so the producer is resolved
// per pickle, the same way a run fills the key: the nearest earlier line
// that runs the one candidate step bound before this line. Two findings
// come from that: a path into a `from` value that the producer's `returns`
// schema does not have (`claim-path-unknown`), and a claim whose two sides
// resolve to the same place (`claim-compares-itself`). A third finding is
// per bound step: a claim step whose `observe` reaches a browser page and
// does not state `poll` (`claim-poll-unstated`).
//
// Each finding claims only what can end one way. A line whose producer is
// missing or ambiguous is left to `from-order-violation`, and a schema this
// module cannot read for certain (a union, a transform, a loose object)
// is taken to have the path. A claim's `view` and `at` read text the step
// returned at run time, so a path inside them is never checked here.

export interface ClaimCheckIssue {
  /** 0-based index into `pickle.steps`: the claim step's line. */
  readonly stepIndex: number;
  readonly stepName: string;
  readonly code: "claim-compares-itself" | "claim-path-unknown";
  readonly message: string;
}

/** Where a path ends in a zod schema: a schema to keep walking, a schema
 * this module cannot read for certain, or a segment that is not there. */
type Walk =
  | { readonly kind: "schema"; readonly schema: z.ZodTypeAny }
  | { readonly kind: "open" }
  | { readonly kind: "missing"; readonly at: number; readonly keys: readonly string[] | null };

interface ZodDef {
  readonly type: string;
  readonly innerType?: z.ZodTypeAny;
  readonly out?: z.ZodTypeAny;
  readonly shape?: Record<string, z.ZodTypeAny>;
  readonly catchall?: z.ZodTypeAny;
  readonly valueType?: z.ZodTypeAny;
  readonly element?: z.ZodTypeAny;
  readonly items?: readonly z.ZodTypeAny[];
  readonly rest?: z.ZodTypeAny | null;
  readonly options?: readonly z.ZodTypeAny[];
  readonly left?: z.ZodTypeAny;
  readonly right?: z.ZodTypeAny;
}

const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "nonoptional", "readonly", "catch"]);
const LEAVES = new Set(["string", "number", "boolean", "bigint", "null", "undefined", "literal", "enum", "date", "nan", "void", "never", "symbol", "template_literal"]);
const INDEX = /^(0|[1-9][0-9]*)$/;

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { def: ZodDef }).def;
}

/** Follows `segments` through `schema` the way `valueAt` reads a parsed
 * value: an object key, or a decimal index into an array or a tuple.
 * Pure. */
export function walkSchema(schema: z.ZodTypeAny, segments: readonly string[], depth = 0): Walk {
  let current = schema;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    let def = defOf(current);
    while (WRAPPERS.has(def.type) && def.innerType !== undefined) {
      current = def.innerType;
      def = defOf(current);
    }
    if (def.type === "pipe" && def.out !== undefined) {
      return walkSchema(def.out, segments.slice(index), depth + 1);
    }
    switch (def.type) {
      case "object": {
        const next = def.shape?.[segment];
        if (next !== undefined) {
          current = next;
          continue;
        }
        const catchall = def.catchall === undefined ? undefined : defOf(def.catchall).type;
        if (catchall !== undefined && catchall !== "never") return { kind: "open" };
        return { kind: "missing", at: index, keys: Object.keys(def.shape ?? {}) };
      }
      case "record":
        if (def.valueType === undefined) return { kind: "open" };
        current = def.valueType;
        continue;
      case "array":
        if (!INDEX.test(segment) || def.element === undefined) return { kind: "missing", at: index, keys: null };
        current = def.element;
        continue;
      case "tuple": {
        if (!INDEX.test(segment)) return { kind: "missing", at: index, keys: null };
        const item = def.items?.[Number(segment)] ?? def.rest ?? undefined;
        if (item === undefined) return { kind: "missing", at: index, keys: null };
        current = item;
        continue;
      }
      case "union": {
        // One option that has the path, or that this module cannot read,
        // is enough: which option a value takes is known only at run time.
        const walks = (def.options ?? []).map((option) => walkSchema(option, segments.slice(index), depth + 1));
        if (walks.length === 0 || walks.some((walk) => walk.kind !== "missing")) return { kind: "open" };
        return { kind: "missing", at: index, keys: null };
      }
      case "intersection": {
        const walks = [def.left, def.right].filter((side) => side !== undefined).map((side) => walkSchema(side!, segments.slice(index), depth + 1));
        if (walks.some((walk) => walk.kind !== "missing")) return { kind: "open" };
        return { kind: "missing", at: index, keys: null };
      }
      default:
        if (LEAVES.has(def.type)) return { kind: "missing", at: index, keys: null };
        return { kind: "open" };
    }
  }
  return { kind: "schema", schema: current };
}

/** The producer a `from` key resolves to on line `stepIndex`: the nearest
 * earlier line that runs the one candidate bound before it, or `null` when
 * none or several are (`from-order-violation` reports both). */
interface Producer {
  readonly lineIndex: number;
  readonly step: Step;
  readonly stepName: string;
  readonly key: string;
}

function resolveProducer(
  step: Step,
  key: string,
  stepIndex: number,
  resolvedNames: readonly (string | undefined)[],
  stepNameOf: ReadonlyMap<Step, string>,
): Producer | null {
  const entry = step.from[key];
  const candidates = entry === undefined ? null : tryFromCandidates(entry);
  if (candidates === null) return null;
  const bound: Producer[] = [];
  for (const [candidate, upstreamKey] of candidates) {
    if (!isStep(candidate)) continue;
    const name = stepNameOf.get(candidate);
    if (name === undefined) continue;
    for (let index = stepIndex - 1; index >= 0; index -= 1) {
      if (resolvedNames[index] === name) {
        bound.push({ lineIndex: index, step: candidate, stepName: name, key: upstreamKey });
        break;
      }
    }
  }
  return bound.length === 1 ? bound[0]! : null;
}

/** Where one side of a claim reads its value, for the self-comparison
 * check, or `null` for a side that cannot be the same as another
 * (a sentence value, a literal, or a key this line does not resolve). */
function placeOf(
  source: "from" | "observe",
  path: string,
  producerOf: (key: string) => Producer | null,
): string | null {
  if (source === "observe") return `observe:${path}`;
  const [head, ...rest] = pathSegments(path) ?? [];
  if (head === undefined) return null;
  const producer = producerOf(head);
  return producer === null ? null : `${producer.lineIndex}:${[producer.key, ...rest].join(".")}`;
}

function expectedPlace(expected: ClaimExpected, producerOf: (key: string) => Producer | null): string | null {
  if (typeof expected === "string" || "literal" in expected) return null;
  if ("from" in expected) return placeOf("from", expected.from, producerOf);
  return placeOf("observe", expected.observe, producerOf);
}

function describePlace(place: string, producers: readonly Producer[], lines: readonly (number | undefined)[]): string {
  if (place.startsWith("observe:")) return `the observe path ${place.slice("observe:".length)}`;
  const [index, path] = [Number(place.slice(0, place.indexOf(":"))), place.slice(place.indexOf(":") + 1)];
  const producer = producers.find((entry) => entry.lineIndex === index);
  const line = lines[index];
  return `${path} of step "${producer?.stepName ?? "?"}"${line === undefined ? "" : ` on line ${line}`}`;
}

function missingMessage(
  stepName: string,
  label: string,
  path: string,
  producer: Producer,
  walk: Extract<Walk, { kind: "missing" }>,
  segments: readonly string[],
  line: number | undefined,
): string {
  const where = segments.slice(0, walk.at).join(".");
  const segment = segments[walk.at]!;
  const has = walk.keys === null ? "" : walk.keys.length === 0 ? ", which has no keys" : `, which has ${walk.keys.join(", ")}`;
  return (
    `Step "${stepName}"'s ${label} reads "${path}", and step "${producer.stepName}"` +
    `${line === undefined ? "" : ` on line ${line}`} returns nothing at "${segment}" under ${where}${has}. ` +
    "The value would be undefined, so the claim would always break"
  );
}

/** Both findings for every claim step bound in `pickle`. */
export function checkClaimSources(pickle: Pickle, vocabulary: Vocabulary, match: StepTextMatcher, lineOf: (index: number) => number | undefined): readonly ClaimCheckIssue[] {
  const issues: ClaimCheckIssue[] = [];
  const resolvedNames = pickle.steps.map((step) => {
    const names = match(step.text).stepNames;
    return names.length === 1 ? names[0] : undefined;
  });
  const stepNameOf = new Map<Step, string>();
  for (const entry of vocabulary.values()) {
    if (entry.kind === "typed") stepNameOf.set(entry.step, entry.name);
  }
  const lines = pickle.steps.map((_, index) => lineOf(index));
  resolvedNames.forEach((stepName, stepIndex) => {
    if (stepName === undefined) return;
    const entry = vocabulary.get(stepName);
    if (entry?.kind !== "typed" || !isClaimStep(entry.step)) return;
    const step: ClaimStep = entry.step;
    const producers = new Map<string, Producer | null>();
    const producerOf = (key: string): Producer | null => {
      if (!producers.has(key)) producers.set(key, Object.hasOwn(step.from, key) ? resolveProducer(step, key, stepIndex, resolvedNames, stepNameOf) : null);
      return producers.get(key)!;
    };
    const fromKeys = new Set(Object.keys(step.from));
    const report = (code: ClaimCheckIssue["code"], message: string): void => {
      issues.push({ stepIndex, stepName, code, message });
    };
    // The schema a from path ends in, reporting a path the producer does
    // not return; `null` when the path is not a from path, is unresolved,
    // or ends in a schema this module cannot read.
    const checkFromPath = (label: string, path: string): z.ZodTypeAny | null => {
      const segments = pathSegments(path);
      if (segments === null || !fromKeys.has(segments[0]!)) return null;
      const producer = producerOf(segments[0]!);
      if (producer === null) return null;
      const upstream = [producer.key, ...segments.slice(1)];
      const walk = walkSchema(producer.step.returns, upstream);
      if (walk.kind === "missing") {
        report("claim-path-unknown", missingMessage(stepName, label, path, producer, walk, upstream, lines[producer.lineIndex]));
        return null;
      }
      return walk.kind === "schema" ? walk.schema : null;
    };
    step.claims.forEach((claim: Claim, index) => {
      const label = `claims[${index}]`;
      const actualSchema = checkFromPath(`${label}.actual`, claim.actual);
      const actualSource = fromKeys.has(pathSegments(claim.actual)?.[0] ?? "") ? "from" : "observe";
      if (isEachClaim(claim)) {
        if (actualSchema !== null && claim.view === undefined && claim.at === undefined) {
          checkItemPaths(stepName, label, claim, actualSchema, report);
        }
        return;
      }
      if (typeof claim.expected === "object" && "from" in claim.expected) {
        checkFromPath(`${label}.expected.from`, claim.expected.from);
      }
      if (claim.view !== undefined || claim.at !== undefined) return;
      const actual = placeOf(actualSource, claim.actual, producerOf);
      const expected = expectedPlace(claim.expected, producerOf);
      if (actual !== null && actual === expected) {
        report(
          "claim-compares-itself",
          `Step "${stepName}"'s ${label} reads ${describePlace(actual, [...producers.values()].filter((p): p is Producer => p !== null), lines)} on both sides, ` +
            "so it holds whatever the behaviour is",
        );
      }
    });
  });
  return issues;
}

/** Item paths of an `each` claim against the array's element schema. */
function checkItemPaths(
  stepName: string,
  label: string,
  claim: Claim & { readonly each: NonNullable<Claim["each"]> },
  arraySchema: z.ZodTypeAny,
  report: (code: ClaimCheckIssue["code"], message: string) => void,
): void {
  const element = walkSchema(arraySchema, ["0"]);
  if (element.kind !== "schema") return;
  const items: readonly [string, ItemClaim][] = [
    ...(claim.each.where ?? []).map((item, index): [string, ItemClaim] => [`${label}.each.where[${index}]`, item]),
    ...claim.each.claims.map((item, index): [string, ItemClaim] => [`${label}.each.claims[${index}]`, item]),
  ];
  for (const [itemLabel, item] of items) {
    if (item.actual === undefined) continue;
    const segments = pathSegments(item.actual);
    if (segments === null) continue;
    const walk = walkSchema(element.schema, segments);
    if (walk.kind !== "missing") continue;
    const has = walk.keys === null ? "" : walk.keys.length === 0 ? ", which has no keys" : `, which has ${walk.keys.join(", ")}`;
    report(
      "claim-path-unknown",
      `Step "${stepName}"'s ${itemLabel}.actual reads "${item.actual}" on each item of ${claim.actual}, and an item has nothing at "${segments[walk.at]}"${has}. ` +
        "The value would be undefined, so the claim would always break",
    );
  }
}

/** `claim-poll-unstated`: a bound claim step whose `observe` reaches a
 * browser page and leaves `poll` unsaid. A page between two renders can
 * show any state for a frame, so whether the step reads once or until the
 * page settles is a choice the step file has to state. */
export function findUnstatedPolls(boundSteps: readonly BoundStepLine[], vocabulary: Vocabulary, graph: FixtureGraph): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const reported = new Set<string>();
  for (const bound of boundSteps) {
    if (reported.has(bound.stepName)) continue;
    const entry = vocabulary.get(bound.stepName);
    if (entry?.kind !== "typed" || !isClaimStep(entry.step) || entry.step.observe === undefined || entry.step.poll !== undefined) continue;
    let needsBrowser: boolean;
    try {
      needsBrowser = stepNeeds(entry.step, graph).needsBrowser;
    } catch {
      continue; // An unreadable bag is `fixture-structural-violation`.
    }
    if (!needsBrowser) continue;
    reported.add(bound.stepName);
    issues.push({
      code: "claim-poll-unstated",
      message:
        `Step "${bound.stepName}" observes a browser page and does not state poll. ` +
        "Write poll: { timeout_ms } to read until every claim holds on two consecutive readings, or poll: false to read once",
      step: bound.stepName,
    });
  }
  return issues;
}
