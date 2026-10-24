// Responsibility: what a condition is, on both sides that name one. An
// environment in nukadoko.program.ts declares the conditions it sets up
// (`conditions: { not_found_hint: true }`), and a scenario names the ones
// it needs with tags on its Feature, Rule, Scenario, or Examples
// (`@with:not_found_hint`, `@with:locale=ja`, `@without:not_found_hint`).
// This module reads those tags, decides whether an environment meets each
// one, and from that the role a scenario's cell has in an environment:
// `required` where the environment meets every condition the scenario
// names, `control` where it meets the opposite of one of them. Boundary:
// pure. It knows nothing of files, pickles, or runs; src/check/ reports
// the tags that do not read, and src/run/ runs and judges the cells.
//
// A condition an environment does not declare counts as false. An
// environment that is a deployment target declares none, and a scenario
// tagged `@without:x` holds there as it holds wherever `x` is off. The
// alternative refused was "an undeclared condition meets nothing", which
// made a scenario with no `@with:` tag fail to be required in a target
// that never heard of the flag.
//
// `@held` is read here too: it is part of a criterion's content beside the
// condition tags, so the two are read together.

/** A condition's name: what `conditions` declares and a tag names. No `=`
 * or `:`, which the tag grammar uses, and nothing a Gherkin tag cannot
 * hold. */
export const CONDITION_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** A value `@with:<name>=<value>` names. Gherkin ends a tag at
 * whitespace and starts a new one at `@`, so a tag can hold neither, and
 * a value with one could never be named. */
export const CONDITION_VALUE_PATTERN = /^[^\s@]+$/;

/** The two values a tag may not name as text: `true` and `false` are the
 * booleans an environment declares, and `@with:x=true` beside a declared
 * `x: true` would read as on to a person and never meet it. A tag writes
 * `@with:x` or `@without:x`, and the program file writes the boolean. */
export const BOOLEAN_TEXTS: ReadonlySet<string> = new Set(["true", "false"]);

/** What an environment declares for one condition: on, off, or a value. */
export type ConditionValue = boolean | string;

/** The conditions one environment declares. */
export type Conditions = Readonly<Record<string, ConditionValue>>;

/** One condition tag, read. */
export type ConditionTag =
  | { readonly kind: "with"; readonly name: string }
  | { readonly kind: "with-value"; readonly name: string; readonly value: string }
  | { readonly kind: "without"; readonly name: string };

/** The tag that marks a criterion that already holds before the change. */
export const HELD_TAG = "@held";

const WITH_PREFIX = "@with:";
const WITHOUT_PREFIX = "@without:";

/** Whether `tag` is one this module reads: a condition tag, well formed or
 * not. Every other tag is the project's own. */
export function isConditionShaped(tag: string): boolean {
  return tag.startsWith(WITH_PREFIX) || tag.startsWith(WITHOUT_PREFIX);
}

/** The condition `tag` names, or `undefined` when it is condition shaped
 * and does not read as one of the three forms. Pure. */
export function readConditionTag(tag: string): ConditionTag | undefined {
  if (tag.startsWith(WITHOUT_PREFIX)) {
    const name = tag.slice(WITHOUT_PREFIX.length);
    return CONDITION_NAME_PATTERN.test(name) ? { kind: "without", name } : undefined;
  }
  if (!tag.startsWith(WITH_PREFIX)) return undefined;
  const body = tag.slice(WITH_PREFIX.length);
  const equals = body.indexOf("=");
  if (equals === -1) return CONDITION_NAME_PATTERN.test(body) ? { kind: "with", name: body } : undefined;
  const name = body.slice(0, equals);
  const value = body.slice(equals + 1);
  if (!CONDITION_NAME_PATTERN.test(name) || !CONDITION_VALUE_PATTERN.test(value) || BOOLEAN_TEXTS.has(value)) return undefined;
  return { kind: "with-value", name, value };
}

/** The tag a `@with:<name>=true` or `@with:<name>=false` means, which is
 * malformed (`BOOLEAN_TEXTS`), so a finding can name the tag to write
 * instead; `undefined` for any other text. Pure. */
export function booleanValueTag(tag: string): ConditionTag | undefined {
  if (!tag.startsWith(WITH_PREFIX)) return undefined;
  const body = tag.slice(WITH_PREFIX.length);
  const equals = body.indexOf("=");
  const name = body.slice(0, equals);
  const value = body.slice(equals + 1);
  if (equals === -1 || !CONDITION_NAME_PATTERN.test(name) || !BOOLEAN_TEXTS.has(value)) return undefined;
  return value === "true" ? { kind: "with", name } : { kind: "without", name };
}

/** The tag text `tag` was read from. Pure. */
export function conditionTagText(tag: ConditionTag): string {
  if (tag.kind === "without") return `${WITHOUT_PREFIX}${tag.name}`;
  if (tag.kind === "with") return `${WITH_PREFIX}${tag.name}`;
  return `${WITH_PREFIX}${tag.name}=${tag.value}`;
}

/** A criterion's tags as this module reads them. */
export interface CriterionTags {
  /** Each condition tag once, in the order the tags first name it: a tag
   * the Feature and its Scenario both carry is one condition. */
  readonly conditions: readonly ConditionTag[];
  readonly held: boolean;
  /** Condition-shaped tags that do not read, each once. */
  readonly malformed: readonly string[];
}

/** Reads every tag a scenario carries, its Feature's, Rule's, and
 * Examples' included. Pure. */
export function readCriterionTags(tags: readonly string[]): CriterionTags {
  const conditions: ConditionTag[] = [];
  const malformed: string[] = [];
  const seen = new Set<string>();
  let held = false;
  for (const tag of tags) {
    if (tag === HELD_TAG) {
      held = true;
      continue;
    }
    if (!isConditionShaped(tag) || seen.has(tag)) continue;
    seen.add(tag);
    const read = readConditionTag(tag);
    if (read === undefined) malformed.push(tag);
    else conditions.push(read);
  }
  return { conditions, held, malformed };
}

/** Whether an environment that declares `conditions` meets `tag`. A
 * condition it does not declare is off (this file's header). Pure. */
export function meets(tag: ConditionTag, conditions: Conditions | undefined): boolean {
  const value = conditions !== undefined && Object.hasOwn(conditions, tag.name) ? conditions[tag.name] : undefined;
  if (tag.kind === "with") return value !== undefined && value !== false;
  if (tag.kind === "with-value") return value === tag.value;
  return value === undefined || value === false;
}

/** How a scenario's cell in one environment counts. A `required` cell
 * has to pass for the criterion to hold; a `control` cell runs where the
 * behaviour the conditions turn on is absent, so a Then that fails there
 * shows the criterion can tell the two apart, and a control never turns
 * the gate red. */
export type CellRole = "required" | "control";

/** How many runs a control has to break the same claim in before its row
 * is `proven`: `--proof-runs` when the flag is not given, and the count
 * the summary leaves unsaid. It lives here, beside the roles, rather than
 * in src/run/, because `nuka --help` prints it from the option table,
 * which must not load the run engine. */
export const DEFAULT_PROOF_RUNS = 2;

/** `required` where the environment meets every condition, `control`
 * where it meets the opposite of at least one. A scenario that names no
 * condition is required everywhere. Every environment is one or the
 * other, so a scenario's cells split the environments a run selects into
 * the two roles. Pure. */
export function roleIn(conditions: readonly ConditionTag[], declared: Conditions | undefined): CellRole {
  return conditions.every((tag) => meets(tag, declared)) ? "required" : "control";
}

/** `name: value` for each condition, as a finding or a summary names an
 * environment's conditions. Pure. */
export function describeConditions(conditions: Conditions | undefined): string {
  const entries = Object.entries(conditions ?? {});
  if (entries.length === 0) return "no conditions";
  return entries.map(([name, value]) => `${name}: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`).join(", ");
}
