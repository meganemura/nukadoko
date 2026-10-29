import type { Pickle } from "@cucumber/messages";
import type { z } from "zod";
import type { ParameterTypeConfig } from "../binding/parameter-type-config.js";
import { stripCaptureNames } from "../binding/pattern.js";
import { asObjectShape, isPlainString } from "../binding/schema-shape.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import type { FixtureGraph } from "../fixture/graph.js";
import { stepNeeds } from "../fixture/step-needs.js";
import {
  ANY_INDEX,
  isEachClaim,
  kindNamed,
  observeWithheldKeys,
  pathSegments,
  placesOverlap,
  type Claim,
  type ClaimExpected,
  type ItemClaim,
  VALUE_KINDS,
} from "../step/claims.js";
import type { ClaimView } from "../record/types.js";
import { isClaimStep, isStep, tryFromCandidates, type ClaimStep, type Step } from "../step/define-step.js";
import type { CheckedPattern } from "./binding-check.js";
import type { BoundStepLine, StepTextMatcher } from "./feature-check.js";
import type { CheckIssue } from "./types.js";

// Responsibility: the `nuka check` findings about a claim step
// (docs/spec.md "Claims"). Where each side of a claim comes from depends on
// which earlier line produced a `from` value, so the producer is resolved
// per pickle, the same way a run fills the key: the nearest earlier line
// that runs the one candidate step bound before this line. Two findings
// come from that: a path into a `from` value that the producer's `returns`
// schema does not have (`claim-path-unknown`), and a claim whose two sides
// resolve to the same place (`claim-compares-itself`), which also covers
// an `observe` that receives the value an expected `from` reads, or a
// value that holds it or that it holds, and an `observe` that receives
// the value an actual `from` reads when the expected value is
// `{ observe }`. A third reads the line's own words: an `is-a` claim
// whose expected sentence key a capture fills with a name that is no kind
// (`claim-kind-unknown`). A fourth reads the producer's `returns` for a
// field: a `lacks-field` claim, or a `where` that selects by one, on a
// value whose schema is an object that drops or refuses every key it
// does not declare, and does not declare that field, so the field is
// never there (`claim-field-stripped`). Two findings are per bound step:
// a claim step whose `observe` reaches a browser page and does not state
// `poll` (`claim-poll-unstated`), and an expected sentence key that a
// parameter type with a transformer fills (`claim-expected-transformed`),
// which only the project's config can say.
//
// Each finding claims only what can end one way. A line whose producer is
// missing or ambiguous is left to `from-order-violation`, and a schema this
// module cannot read for certain (a union, a transform, a loose object)
// is taken to have the path. A claim's `view` and `at` read text the step
// returned at run time, so a path inside them is never checked against a
// schema; they are steps of the path for the self-comparison check, so
// `at: "count"` on a value reads the same place as the path `.count`. An
// item of an `each` is one index the check does not know (`ANY_INDEX`),
// so an item side is the same as another only when both paths are written
// the same; the run, which knows the index, breaks the rest.

export interface ClaimCheckIssue {
  /** 0-based index into `pickle.steps`: the claim step's line. */
  readonly stepIndex: number;
  readonly stepName: string;
  readonly code: "claim-compares-itself" | "claim-field-stripped" | "claim-kind-unknown" | "claim-path-unknown";
  readonly message: string;
}

/** Where one side of a claim reads its value, as the check knows it: the
 * origin (`observe`, or the line of the producing step) and the path,
 * with a view as one segment and an item index as `ANY_INDEX`. */
interface CheckPlace {
  readonly origin: string;
  readonly segments: readonly string[];
  /** How a message names the place. */
  readonly text: string;
}

/** Whether two places are certainly the same: the same origin and the
 * same segments, with `ANY_INDEX` equal only to itself. Pure. */
export function certainlySamePlace(a: Pick<CheckPlace, "origin" | "segments">, b: Pick<CheckPlace, "origin" | "segments">): boolean {
  return a.origin === b.origin && a.segments.length === b.segments.length && a.segments.every((segment, index) => segment === b.segments[index]);
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

const WRAPPERS: ReadonlySet<string> = new Set(["optional", "nullable", "default", "prefault", "nonoptional", "readonly", "catch"]);
// The wrappers that parse the value they hold, so an object inside one
// still drops the keys it does not declare. `default` and `catch` are not
// here: each can return its own value without parsing it, and that value
// may hold any key, at any depth below it.
const PARSING_WRAPPERS: ReadonlySet<string> = new Set(["optional", "nullable", "nonoptional", "readonly", "prefault"]);
const LEAVES = new Set(["string", "number", "boolean", "bigint", "null", "undefined", "literal", "enum", "date", "nan", "void", "never", "symbol", "template_literal"]);
const INDEX = /^(0|[1-9][0-9]*)$/;

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { def: ZodDef }).def;
}

/** Follows `segments` through `schema` the way `valueAt` reads a parsed
 * value: an object key, or a decimal index into an array or a tuple.
 * `wrappers` names the wrappers it sees through; any other is open.
 * Pure. */
export function walkSchema(schema: z.ZodTypeAny, segments: readonly string[], depth = 0, wrappers: ReadonlySet<string> = WRAPPERS): Walk {
  let current = schema;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    let def = defOf(current);
    while (wrappers.has(def.type) && def.innerType !== undefined) {
      current = def.innerType;
      def = defOf(current);
    }
    if (def.type === "pipe" && def.out !== undefined) {
      return walkSchema(def.out, segments.slice(index), depth + 1, wrappers);
    }
    switch (def.type) {
      case "object": {
        // An own key only: `constructor` or `toString` is on every
        // object's prototype, and the run reads own properties alone.
        const next = def.shape !== undefined && Object.hasOwn(def.shape, segment) ? def.shape[segment] : undefined;
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
        const walks = (def.options ?? []).map((option) => walkSchema(option, segments.slice(index), depth + 1, wrappers));
        if (walks.length === 0 || walks.some((walk) => walk.kind !== "missing")) return { kind: "open" };
        return { kind: "missing", at: index, keys: null };
      }
      case "intersection": {
        const walks = [def.left, def.right].filter((side) => side !== undefined).map((side) => walkSchema(side!, segments.slice(index), depth + 1, wrappers));
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

/** The keys an object schema keeps, when it keeps no other key for
 * certain: a `z.object` with no catchall, which drops a key it does not
 * declare, or a `never` catchall (`z.strictObject`), which refuses it.
 * `null` for any other schema, whose parsed value may hold any key.
 * Pure. */
export function closedObjectKeys(schema: z.ZodTypeAny): readonly string[] | null {
  let def = defOf(schema);
  while (PARSING_WRAPPERS.has(def.type) && def.innerType !== undefined) def = defOf(def.innerType);
  if (def.type !== "object") return null;
  const catchall = def.catchall === undefined ? undefined : defOf(def.catchall).type;
  if (catchall !== undefined && catchall !== "never") return null;
  return Object.keys(def.shape ?? {});
}

/** The keys the object at `segments` inside `schema` keeps, as
 * `closedObjectKeys` names them, or `null`. The walk sees through the
 * parsing wrappers alone: a default or a catch anywhere on the path can
 * hand back its own value, with any key at any depth below it. Pure. */
export function closedObjectKeysAt(schema: z.ZodTypeAny, segments: readonly string[]): readonly string[] | null {
  const walk = walkSchema(schema, segments, 0, PARSING_WRAPPERS);
  return walk.kind === "schema" ? closedObjectKeys(walk.schema) : null;
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

/** Where a path reads its value, for the self-comparison check, or
 * `null` for a path this line does not resolve to one producer. */
function placeOf(
  source: "from" | "observe",
  path: string,
  producerOf: (key: string) => Producer | null,
  lineOf: (index: number) => number | undefined,
): CheckPlace | null {
  const segments = pathSegments(path);
  if (segments === null) return null;
  if (source === "observe") return { origin: "observe", segments, text: `the observe path ${path}` };
  const [head, ...rest] = segments;
  const producer = producerOf(head!);
  if (producer === null) return null;
  const line = lineOf(producer.lineIndex);
  const upstream = [producer.key, ...rest];
  return {
    origin: `line:${producer.lineIndex}`,
    segments: upstream,
    text: `${upstream.join(".")} of step "${producer.stepName}"${line === undefined ? "" : ` on line ${line}`}`,
  };
}

/** `place` read through `view`, then `at`, then counted, the way the
 * run walks it: a count is another value than the array it counts. */
function shapedPlace(place: CheckPlace, view: ClaimView | undefined, at: string | undefined, count: boolean | undefined): CheckPlace {
  const viewed = view === undefined ? place : { origin: place.origin, segments: [...place.segments, `#${view}`], text: `${place.text} as ${view}` };
  const walked = at === undefined || at === "" ? viewed : { origin: viewed.origin, segments: [...viewed.segments, ...at.split(".")], text: `${viewed.text} at ${at}` };
  return count === true ? { origin: walked.origin, segments: [...walked.segments, "#count"], text: `the count of ${walked.text}` } : walked;
}

/** `place` walked further by `path`. */
function placeUnder(place: CheckPlace, segments: readonly string[], text: string): CheckPlace {
  return { origin: place.origin, segments: [...place.segments, ...segments], text };
}

function expectedPlace(
  expected: ClaimExpected,
  producerOf: (key: string) => Producer | null,
  lineOf: (index: number) => number | undefined,
): CheckPlace | null {
  if (typeof expected === "string" || "literal" in expected) return null;
  if ("from" in expected) return placeOf("from", expected.from, producerOf, lineOf);
  return placeOf("observe", expected.observe, producerOf, lineOf);
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
  const segment = segments[walk.at]!;
  const where = walk.at === 0 ? "at the top of its result" : `under ${segments.slice(0, walk.at).join(".")}`;
  const has = walk.keys === null ? "" : walk.keys.length === 0 ? ", which has no keys" : `, which has ${walk.keys.join(", ")}`;
  // Only the first segment can hold a dot: it is the from entry's key,
  // which the run reads as one key, never as a path.
  const oneLevel =
    walk.at === 0 && segment.includes(".") && walkSchema(producer.step.returns, segment.split(".")).kind !== "missing"
      ? ` "${segment}" is one key, not a path: a from key reads one level of the result.`
      : "";
  return (
    `Step "${stepName}"'s ${label} reads "${path}", and step "${producer.stepName}"` +
    `${line === undefined ? "" : ` on line ${line}`} returns nothing at "${segment}" ${where}${has}.${oneLevel} ` +
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
    const lineOf = (index: number): number | undefined => lines[index];
    const comparesItself = (label: string, actual: CheckPlace | null, expected: CheckPlace | null): void => {
      if (actual === null || expected === null || !certainlySamePlace(actual, expected)) return;
      const where = actual.text === expected.text ? `${actual.text} on both sides` : `${actual.text} as its actual value and ${expected.text} as its expected value, one place`;
      report("claim-compares-itself", `Step "${stepName}"'s ${label} reads ${where}, so it holds whatever the behaviour is`);
    };
    reportUnknownKinds(step, match(pickle.steps[stepIndex]!.text).matched, pickle.steps[stepIndex]!.text, (message) =>
      report("claim-kind-unknown", `Step "${stepName}"'s ${message}`),
    );
    const captured = capturedTexts(match(pickle.steps[stepIndex]!.text).matched, pickle.steps[stepIndex]!.text);
    const argsShape = asObjectShape(step.args) ?? null;
    // A lacks-field claim, or a where clause, on a value the producer's
    // returns parses as an object that keeps no undeclared key: `actualPath`
    // is the claim's from path, `inside` the segments it reads below that,
    // and `path` names the place for the reader.
    const strippedField = (label: string, entry: ItemClaim, actualPath: string, inside: readonly string[], path: string, where: boolean): void => {
      const field = lackedField(entry, captured, argsShape);
      if (field === null) return;
      const segments = pathSegments(actualPath);
      if (segments === null || !fromKeys.has(segments[0]!)) return;
      const producer = producerOf(segments[0]!);
      if (producer === null) return;
      const keys = closedObjectKeysAt(producer.step.returns, [producer.key, ...segments.slice(1), ...inside]);
      if (keys === null || keys.includes(field)) return;
      const line = lines[producer.lineIndex];
      const has = keys.length === 0 ? "no keys" : keys.join(", ");
      report(
        "claim-field-stripped",
        `Step "${stepName}"'s ${label} is lacks-field ${JSON.stringify(field)} on ${path}, and step "${producer.stepName}"${line === undefined ? "" : ` on line ${line}`} ` +
          `returns that value through an object schema that declares ${has}, which drops any key it does not declare, or refuses it as a strict object. ` +
          `${field} is never there, so ${where ? "where selects every item, whatever the behaviour is" : "the claim holds whatever the behaviour is"}`,
      );
    };
    // Every place of the step that `observe` must not receive, for the
    // observe check: each expected `{ from }` place, and each actual
    // `from` place whose claim takes its expected value from `observe`.
    const notObservePlaces: { readonly label: string; readonly place: CheckPlace }[] = [];
    const noteExpectedFrom = (label: string, expected: ClaimExpected): void => {
      if (typeof expected !== "object" || !("from" in expected)) return;
      const place = placeOf("from", expected.from, producerOf, lineOf);
      if (place !== null) notObservePlaces.push({ label: `${label}.expected`, place });
    };
    const noteActualFrom = (label: string, expected: ClaimExpected, actual: CheckPlace | null, actualSource: "from" | "observe"): void => {
      if (actual === null || actualSource !== "from" || typeof expected !== "object" || !("observe" in expected)) return;
      notObservePlaces.push({ label: `${label}.actual`, place: actual });
    };
    step.claims.forEach((claim: Claim, index) => {
      const label = `claims[${index}]`;
      const actualSchema = checkFromPath(`${label}.actual`, claim.actual);
      const actualSource = fromKeys.has(pathSegments(claim.actual)?.[0] ?? "") ? "from" : "observe";
      const top = placeOf(actualSource, claim.actual, producerOf, lineOf);
      const actual = top === null ? null : shapedPlace(top, claim.view, claim.at, claim.count);
      if (isEachClaim(claim)) {
        if (actualSchema !== null && claim.view === undefined && claim.at === undefined) {
          checkItemPaths(stepName, label, claim, actualSchema, report);
          const entries: readonly [string, ItemClaim, boolean][] = [
            ...(claim.each.where ?? []).map((item, itemIndex): [string, ItemClaim, boolean] => [`${label}.each.where[${itemIndex}]`, item, true]),
            ...claim.each.claims.map((item, itemIndex): [string, ItemClaim, boolean] => [`${label}.each.claims[${itemIndex}]`, item, false]),
          ];
          for (const [itemLabel, item, where] of entries) {
            const inside = item.view === undefined ? itemSegmentsOf(item) : null;
            const named = inside === null || inside.length === 0 ? "each item" : `${inside.join(".")} of each item`;
            if (inside !== null) strippedField(itemLabel, item, claim.actual, ["0", ...inside], `${named} of ${claim.actual}`, where);
          }
        }
        const items: readonly [string, ItemClaim][] = [
          ...(claim.each.where ?? []).map((item, itemIndex): [string, ItemClaim] => [`${label}.each.where[${itemIndex}]`, item]),
          ...claim.each.claims.map((item, itemIndex): [string, ItemClaim] => [`${label}.each.claims[${itemIndex}]`, item]),
        ];
        for (const [itemLabel, item] of items) {
          if (typeof item.expected === "object" && "from" in item.expected) checkFromPath(`${itemLabel}.expected.from`, item.expected.from);
          noteExpectedFrom(itemLabel, item.expected);
          const itemSegments = item.actual === undefined ? [] : (pathSegments(item.actual) ?? null);
          if (actual === null || itemSegments === null) {
            noteActualFrom(itemLabel, item.expected, actual, actualSource);
            continue;
          }
          const itemPlace = shapedPlace(
            placeUnder(actual, [ANY_INDEX, ...itemSegments], `${item.actual ?? "item"} of each item of ${actual.text}`),
            item.view,
            item.at,
            item.count,
          );
          noteActualFrom(itemLabel, item.expected, itemPlace, actualSource);
          comparesItself(itemLabel, itemPlace, expectedPlace(item.expected, producerOf, lineOf));
        }
        return;
      }
      if (typeof claim.expected === "object" && "from" in claim.expected) {
        checkFromPath(`${label}.expected.from`, claim.expected.from);
      }
      const at = claim.view === undefined ? (claim.at === undefined ? [] : pathSegments(claim.at)) : null;
      if (actualSchema !== null && at !== null) strippedField(label, claim, claim.actual, at, claim.at === undefined ? claim.actual : `${claim.actual} at ${claim.at}`, false);
      noteExpectedFrom(label, claim.expected);
      noteActualFrom(label, claim.expected, actual, actualSource);
      // expected_view is on a sentence key alone, which no other side reads.
      comparesItself(label, actual, expectedPlace(claim.expected, producerOf, lineOf));
    });
    // An observe that receives a value an expected `from` reads, or one
    // that holds it or that it holds, could return the expected value as
    // the actual one. `observe` never receives an expected key, so only a
    // second key from the same producer can carry it. The mirror: an
    // observe that receives the value an actual `from` reads could return
    // it as the expected `{ observe }` value. The actual key itself is
    // withheld (`observeWithheldKeys`), so only a second key can.
    if (step.observe !== undefined) {
      const withheld = observeWithheldKeys(step.claims, fromKeys);
      for (const key of Object.keys(step.from)) {
        if (withheld.has(key)) continue;
        const input = placeOf("from", key, producerOf, lineOf);
        if (input === null) continue;
        const hit = notObservePlaces.find((entry) => placesOverlap(input, entry.place));
        if (hit === undefined) continue;
        report(
          "claim-compares-itself",
          `Step "${stepName}"'s observe receives args.${key}, which is ${input.text}, and its ${hit.label} reads ${hit.place.text}, ` +
            `so observe could return the value the claim compares it with. Take ${key} out of this step's from, so observe does not receive it, or fill it from another step`,
        );
      }
    }
  });
  return issues;
}

/** The path an item claim reads inside its item, `actual` then `at`, or
 * `null` for one that is not a path. */
function itemSegmentsOf(item: ItemClaim): readonly string[] | null {
  const actual = item.actual === undefined ? [] : pathSegments(item.actual);
  const at = item.at === undefined ? [] : pathSegments(item.at);
  return actual === null || at === null ? null : [...actual, ...at];
}

/** The field a `lacks-field` claim names on this line before it runs: a
 * literal, or a plain string key a capture fills with its own text. `null`
 * for any other claim, and for a field only the run can know (a
 * docstring, a table, a custom type's transformer, a blank name). */
function lackedField(entry: ItemClaim, captured: ReadonlyMap<string, string>, shape: Record<string, z.ZodTypeAny> | null): string | null {
  if (entry.compare !== "lacks-field") return null;
  const expected = entry.expected;
  let name: string | undefined;
  if (typeof expected === "object") {
    name = "literal" in expected && typeof expected.literal === "string" ? expected.literal : undefined;
  } else if (entry.expected_view === undefined || entry.expected_view === "text") {
    const schema = shape?.[expected];
    const text = schema !== undefined && isPlainString(schema) ? captured.get(expected) : undefined;
    name = entry.expected_view === "text" ? text?.trimEnd() : text;
  }
  return name === undefined || name.trim() === "" ? null : name;
}

/** The value each capture of a typed pattern gives on `text`, by key, for
 * the built-in types whose value is the line's own text: `{word}`, the
 * anonymous `{key:}`, and `{string}` without its quotes, unescaped the way
 * the run's transformer does. A custom type's transformer is never run by
 * `nuka check`, and a number type gives no name, so neither is here. */
function capturedTexts(matched: CheckedPattern | undefined, text: string): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  if (matched?.matcherKind !== "expression") return texts;
  const args = matched.expression.match(text);
  if (args === null) return texts;
  matched.captures.forEach((capture, index) => {
    const raw = args[index]?.group.value;
    if (raw === undefined) return;
    if (capture.type === "word" || capture.type === "") texts.set(capture.key, raw);
    else if (capture.type === "string" && raw.length >= 2) texts.set(capture.key, raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'"));
  });
  return texts;
}

/** `claim-kind-unknown`: an `is-a` claim whose expected value is a sentence
 * key this line fills, through a capture, with a name that is no kind.
 * Only a plain string key read as it is or as text counts, so the value
 * the claim reads is the captured text and the run would break the claim
 * on this line for certain. */
function reportUnknownKinds(step: ClaimStep, matched: CheckedPattern | undefined, text: string, report: (message: string) => void): void {
  const captured = capturedTexts(matched, text);
  if (captured.size === 0) return;
  const shape = asObjectShape(step.args);
  step.claims.forEach((claim, index) => {
    const label = `claims[${index}]`;
    const entries: readonly [string, ItemClaim | Claim][] = isEachClaim(claim)
      ? [
          ...(claim.each.where ?? []).map((item, itemIndex): [string, ItemClaim] => [`${label}.each.where[${itemIndex}]`, item]),
          ...claim.each.claims.map((item, itemIndex): [string, ItemClaim] => [`${label}.each.claims[${itemIndex}]`, item]),
        ]
      : [[label, claim]];
    for (const [entryLabel, entry] of entries) {
      if (entry.compare !== "is-a" || typeof entry.expected !== "string") continue;
      if (entry.expected_view !== undefined && entry.expected_view !== "text") continue;
      const named = captured.get(entry.expected);
      const schema = shape?.[entry.expected];
      if (named === undefined || schema === undefined || !isPlainString(schema) || kindNamed(named) !== undefined) continue;
      report(
        `${entryLabel}.expected is args.${entry.expected}, which this line fills with ${JSON.stringify(named)}, and is-a names one of the kinds ${VALUE_KINDS.join(", ")}, so the claim would always break`,
      );
    }
  });
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

/** `claim-expected-transformed`: a bound claim step whose expected value is
 * an args key that a pattern fills with a parameter type the project
 * registered with a transformer. The transformer runs before the args
 * schema, so the record would label the value `sentence:` while step code
 * decided it. `defineStep` refuses a schema that rewrites the key; which
 * parameter type fills a capture is known only once the config is read,
 * so this half is the check's. A built-in type converts the text into the
 * type it names and no more, so it is not reported. */
export function findTransformedExpected(
  boundSteps: readonly BoundStepLine[],
  vocabulary: Vocabulary,
  customTypes: readonly ParameterTypeConfig[],
): CheckIssue[] {
  const transformed = new Set(customTypes.filter((type) => type.transformer !== undefined).map((type) => type.name));
  if (transformed.size === 0) return [];
  const issues: CheckIssue[] = [];
  const reported = new Set<string>();
  for (const bound of boundSteps) {
    if (reported.has(bound.stepName)) continue;
    reported.add(bound.stepName);
    const entry = vocabulary.get(bound.stepName);
    if (entry?.kind !== "typed" || !isClaimStep(entry.step)) continue;
    const step = entry.step;
    const sentenceKeys = new Map<string, string>();
    step.claims.forEach((claim, index) => {
      const label = `claims[${index}]`;
      if (!isEachClaim(claim)) {
        if (typeof claim.expected === "string" && !sentenceKeys.has(claim.expected)) sentenceKeys.set(claim.expected, label);
        return;
      }
      const items: readonly [string, ItemClaim][] = [
        ...(claim.each.where ?? []).map((item, itemIndex): [string, ItemClaim] => [`${label}.each.where[${itemIndex}]`, item]),
        ...claim.each.claims.map((item, itemIndex): [string, ItemClaim] => [`${label}.each.claims[${itemIndex}]`, item]),
      ];
      for (const [itemLabel, item] of items) {
        if (typeof item.expected === "string" && !sentenceKeys.has(item.expected)) sentenceKeys.set(item.expected, itemLabel);
      }
    });
    for (const pattern of step.patterns) {
      let captures: ReturnType<typeof stripCaptureNames>["captures"];
      try {
        captures = stripCaptureNames(pattern).captures;
      } catch {
        continue; // A pattern that does not scan is a pattern finding.
      }
      for (const capture of captures) {
        const label = sentenceKeys.get(capture.key);
        if (label === undefined || !transformed.has(capture.type)) continue;
        issues.push({
          code: "claim-expected-transformed",
          message:
            `Step "${bound.stepName}"'s ${label}.expected is args.${capture.key}, and its pattern "${pattern}" fills it with the parameter type {${capture.type}}, ` +
            "whose transformer rewrites the line's text before the claim reads it, so code would decide what the claim compares. " +
            `Capture ${capture.key} with a type that has no transformer, such as {${capture.key}:string}, and read it with expected_view if it needs one`,
          step: bound.stepName,
        });
      }
    }
  }
  return issues;
}
