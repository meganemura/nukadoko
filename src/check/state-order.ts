import type { Pickle } from "@cucumber/messages";
import { exampleLine } from "../binding/example-line.js";
import { argsSchemaRewrite, asObjectShape, isPlainString, schemaRewrite } from "../binding/schema-shape.js";
import type { HookRegistration, HookType } from "../compat/hooks.js";
import { hookApplies } from "../compat/tag-expression.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { isClaimStep, type Step } from "../step/define-step.js";
import type { StateUse } from "../step/states.js";
import { capturedTexts } from "./claim-check.js";
import type { StepTextMatcher } from "./feature-check.js";

// Responsibility: docs/spec.md "States" judged for one pickle: whether a
// line whose step requires a state can only be reached with that state not
// held, by what the steps of the lines before it declare. One judgment,
// two callers, the shape from-order.ts set: nuka check (feature-check.ts,
// every pickle of a feature file, a finding several reach the same way
// reported once) and nuka run's pre-run guard (run-scenario.ts, the pickle
// about to run), so a scenario never passes one and fails the other.
// Boundary: reads declarations and the feature text, never a step record.
// It never says a state holds, only that it cannot. Whatever it has no
// declaration to read (a compat step, a line no step matches, a compat
// Before or AfterStep hook, a custom World) makes the state unknown, and
// unknown is never reported.
//
// The walk follows the one path on which a line runs at all: every line
// before it passed, since a failed line skips the rest of its pickle. So
// what holds once a step has passed is all a later line can depend on.
// A typed step that names a state nowhere leaves it as it was: the check
// is closed over the vocabulary, and a step that gives a state without
// saying so is the one way a finding points at a declaration rather than
// at the scenario, which the fix line names when it can apply.

/** The compat code that runs inside a scenario, outside every line. */
export interface StateCompat {
  readonly hooks: readonly HookRegistration[];
  /** Whether a step file called setWorldConstructor: its constructor runs
   * before the first line of every scenario. */
  readonly customWorld: boolean;
}

/** Why a requiring line can only run without the state. */
export type StateCause =
  /** No step's gives names the state, so no line can give it. */
  | { readonly kind: "no-giver" }
  /** No earlier line gave it to this holder. `givenToOthers` are the
   * earlier lines that gave it to another one. */
  | {
      readonly kind: "never-given";
      readonly givenToOthers: readonly { readonly stepIndex: number; readonly holder: string }[];
      readonly undeclared: readonly string[];
    }
  /** The line at `stepIndex` ended it, and no line since gave it again. */
  | { readonly kind: "ended"; readonly stepIndex: number; readonly stepName: string; readonly undeclared: readonly string[] }
  /** The line does not name its holder, and no holder holds the state. */
  | { readonly kind: "held-by-none"; readonly undeclared: readonly string[] };

/** One requiring line nuka check reports and nuka run refuses. */
export interface StateIssue {
  /** 0-based index into pickle.steps: the requiring line. */
  readonly stepIndex: number;
  readonly stepName: string;
  readonly state: string;
  /** The requiring step's args key for the holder; undefined for an unkeyed state. */
  readonly key: string | undefined;
  /** The holder the line names; undefined for an unkeyed state, and for a
   * keyed one whose value only the run knows. */
  readonly holder: string | undefined;
  readonly cause: StateCause;
  /** Later lines that require the same state for the same holder with the
   * same fact behind them: the fix for this line settles them too. */
  readonly alsoRequiredAt: readonly number[];
  readonly message: string;
  readonly fix: string;
}

/** A state some steps name with a holder key and others without. No line
 * that requires it is judged, so this is reported rather than left silent. */
export interface StateShapeIssue {
  readonly state: string;
  readonly keyed: readonly string[];
  readonly unkeyed: readonly string[];
  readonly message: string;
  readonly fix: string;
}

type Fact =
  | { readonly holds: "held" }
  | { readonly holds: "not-held"; readonly endedAt: number | undefined }
  | { readonly holds: "unknown" };

const HELD: Fact = { holds: "held" };
const NEVER_GIVEN: Fact = { holds: "not-held", endedAt: undefined };
const UNKNOWN: Fact = { holds: "unknown" };

/** What the walk knows about one state just before a line. `unnamed`
 * stands for every holder no line has named yet. */
interface StateFacts {
  readonly byHolder: ReadonlyMap<string, Fact>;
  readonly unnamed: Fact;
}

const ALL_UNKNOWN: StateFacts = { byHolder: new Map(), unnamed: UNKNOWN };

/** The holder an entry names on a line. An unkeyed state has the one
 * holder "". */
type Holder = { readonly stated: true; readonly value: string } | { readonly stated: false };

const UNKEYED: Holder = { stated: true, value: "" };
const UNSTATED: Holder = { stated: false };

type Change =
  | { readonly state: string; readonly op: "give" | "end"; readonly holder: Holder }
  | { readonly state: string; readonly op: "unknown" };

type Line =
  | { readonly kind: "opaque" }
  | { readonly kind: "typed"; readonly name: string; readonly step: Step; readonly captured: ReadonlyMap<string, string> };

/** A step with a pattern whose gives names the state: a step a line can run. */
interface Giver {
  readonly name: string;
  readonly key: string | undefined;
  readonly pattern: string;
}

interface StateInfo {
  readonly keyed: readonly string[];
  readonly unkeyed: readonly string[];
  readonly givers: readonly Giver[];
}

interface StateIndex {
  readonly states: ReadonlyMap<string, StateInfo>;
  /** By step: the states its transitive parts name in gives or ends. */
  readonly throughParts: ReadonlyMap<Step, ReadonlySet<string>>;
}

const indexes = new WeakMap<Vocabulary, StateIndex>();

/** Derived from the vocabulary and kept by its identity, so the walk over
 * every pickle of one check reads it once. */
function indexOf(vocabulary: Vocabulary): StateIndex {
  const known = indexes.get(vocabulary);
  if (known !== undefined) return known;
  const states = new Map<string, { keyed: string[]; unkeyed: string[]; givers: Giver[] }>();
  const throughParts = new Map<Step, ReadonlySet<string>>();
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") continue;
    const { requires, gives, ends } = entry.step.states;
    for (const use of [...requires, ...gives, ...ends]) {
      const info = states.get(use.state) ?? { keyed: [], unkeyed: [], givers: [] };
      states.set(use.state, info);
      const shape = use.key === undefined ? info.unkeyed : info.keyed;
      if (!shape.includes(entry.name)) shape.push(entry.name);
    }
    const pattern = entry.step.patterns[0];
    if (pattern !== undefined) {
      for (const use of gives) {
        const givers = states.get(use.state)!.givers;
        if (!givers.some((giver) => giver.name === entry.name)) givers.push({ name: entry.name, key: use.key, pattern });
      }
    }
    throughParts.set(entry.step, statesOfParts(entry.step));
  }
  const index: StateIndex = { states, throughParts };
  indexes.set(vocabulary, index);
  return index;
}

function statesOfParts(step: Step): ReadonlySet<string> {
  const states = new Set<string>();
  const seen = new Set<Step>([step]);
  const visit = (current: Step): void => {
    for (const part of current.parts) {
      if (seen.has(part)) continue;
      seen.add(part);
      for (const use of [...part.states.gives, ...part.states.ends]) states.add(use.state);
      visit(part);
    }
  };
  visit(step);
  return states;
}

function isMismatched(info: StateInfo): boolean {
  return info.keyed.length > 0 && info.unkeyed.length > 0;
}

/** A tag expression nukadoko cannot read counts as applying: its own
 * finding stops the run, and silence is the side to err on. */
function applies(hook: HookRegistration, tags: readonly string[]): boolean {
  try {
    return hookApplies(hook.tags, tags);
  } catch {
    return true;
  }
}

/** The holder a line names for `use`: the captured text, when the pattern
 * captures the key as text and the key's schema hands that text to the
 * step unchanged. Anything else is a holder only the run knows. */
function holderOf(line: Extract<Line, { kind: "typed" }>, use: StateUse): Holder {
  if (use.key === undefined) return UNKEYED;
  const text = line.captured.get(use.key);
  const field = asObjectShape(line.step.args)?.[use.key];
  if (text === undefined || field === undefined || !isPlainString(field)) return UNSTATED;
  if (schemaRewrite(field) !== null || argsSchemaRewrite(line.step.args) !== null) return UNSTATED;
  return { stated: true, value: text };
}

function changesOf(line: Line, index: StateIndex): readonly Change[] | "unknown" {
  if (line.kind === "opaque") return "unknown";
  const { gives, ends } = line.step.states;
  const declared = new Set([...gives, ...ends].map((use) => use.state));
  return [
    ...ends.map((use): Change => ({ state: use.state, op: "end", holder: holderOf(line, use) })),
    ...gives.map((use): Change => ({ state: use.state, op: "give", holder: holderOf(line, use) })),
    ...[...(index.throughParts.get(line.step) ?? [])].filter((state) => !declared.has(state)).map((state): Change => ({ state, op: "unknown" })),
  ];
}

function applyChange(facts: StateFacts, change: Change, at: number): StateFacts {
  if (change.op === "unknown") return ALL_UNKNOWN;
  if (change.holder.stated) {
    const fact: Fact = change.op === "give" ? HELD : { holds: "not-held", endedAt: at };
    return { byHolder: new Map(facts.byHolder).set(change.holder.value, fact), unnamed: facts.unnamed };
  }
  // Exactly one holder changes, and the walk does not know which.
  const changing = change.op === "give" ? "not-held" : "held";
  const blur = (fact: Fact): Fact => (fact.holds === changing ? UNKNOWN : fact);
  return { byHolder: new Map([...facts.byHolder].map(([holder, fact]) => [holder, blur(fact)])), unnamed: blur(facts.unnamed) };
}

interface Draft {
  readonly stepIndex: number;
  readonly stepName: string;
  readonly use: StateUse;
  readonly holder: string | undefined;
  readonly cause: StateCause;
  readonly alsoRequiredAt: number[];
}

/**
 * Walks pickle.steps once (gherkin has already put a Background first and
 * filled each Examples row) and returns every requiring line that only one
 * outcome can reach: the state not held. `lineOf` gives a step's feature
 * line for the message. Pure.
 */
export function checkStateOrder(
  pickle: Pickle,
  vocabulary: Vocabulary,
  match: StepTextMatcher,
  compat: StateCompat,
  lineOf: (stepIndex: number) => number | undefined,
): readonly StateIssue[] {
  const index = indexOf(vocabulary);
  const at = labelOf(lineOf);
  return walkStates(pickle, vocabulary, index, match, compat).map((draft) => ({
    stepIndex: draft.stepIndex,
    stepName: draft.stepName,
    state: draft.use.state,
    key: draft.use.key,
    holder: draft.holder,
    cause: draft.cause,
    alsoRequiredAt: draft.alsoRequiredAt,
    ...render(draft, at, pickle, index, draft.alsoRequiredAt.map(at), at(Math.max(draft.stepIndex, ...draft.alsoRequiredAt))),
  }));
}

/** One state-missing finding of nuka check: a requiring line of a feature file. */
export interface StateFinding {
  readonly line: number | undefined;
  readonly stepName: string;
  readonly message: string;
  readonly fix: string;
}

/**
 * checkStateOrder over every pickle of one feature file, for nuka check. A
 * Background line reaches the same finding in every scenario, each with
 * its own later lines folded into it, so the finding is reported once with
 * the folded lines of all of them: one giving line before it settles every
 * one. Pure.
 */
export function checkFeatureStateOrder(
  pickles: readonly { readonly pickle: Pickle; readonly lineOf: (stepIndex: number) => number | undefined }[],
  vocabulary: Vocabulary,
  match: StepTextMatcher,
  compat: StateCompat,
): readonly StateFinding[] {
  const index = indexOf(vocabulary);
  interface Merged {
    readonly draft: Draft;
    readonly pickle: Pickle;
    readonly at: (stepIndex: number) => string;
    readonly line: number | undefined;
    /** By label, the line it sorts by. */
    readonly folded: Map<string, number>;
    /** The scenarios the folded lines come from. */
    readonly scenarios: Set<string>;
  }
  const merged = new Map<string, Merged>();
  for (const { pickle, lineOf } of pickles) {
    const at = labelOf(lineOf);
    for (const draft of walkStates(pickle, vocabulary, index, match, compat)) {
      const alone = render(draft, at, pickle, index, [], at(draft.stepIndex));
      const key = JSON.stringify([lineOf(draft.stepIndex) ?? null, alone.message, alone.fix]);
      const found = merged.get(key) ?? { draft, pickle, at, line: lineOf(draft.stepIndex), folded: new Map<string, number>(), scenarios: new Set<string>() };
      merged.set(key, found);
      for (const stepIndex of draft.alsoRequiredAt) found.folded.set(at(stepIndex), lineOf(stepIndex) ?? Number.POSITIVE_INFINITY);
      if (draft.alsoRequiredAt.length > 0) found.scenarios.add(pickle.astNodeIds[0] ?? pickle.id);
    }
  }
  return [...merged.values()].map(({ draft, pickle, at, line, folded, scenarios }) => {
    const labels = [...folded].sort(([, a], [, b]) => a - b).map(([label]) => label);
    // No one line is below every folded line when they lie in different scenarios.
    const last = scenarios.size > 1 ? undefined : (labels.at(-1) ?? at(draft.stepIndex));
    return { line, stepName: draft.stepName, ...render(draft, at, pickle, index, labels, last) };
  });
}

/** "line 12", or the step's place in the scenario when it has no line. */
function labelOf(lineOf: (stepIndex: number) => number | undefined): (stepIndex: number) => string {
  return (stepIndex) => {
    const line = lineOf(stepIndex);
    return line === undefined ? `step ${stepIndex + 1} of the scenario` : `line ${line}`;
  };
}

function walkStates(pickle: Pickle, vocabulary: Vocabulary, index: StateIndex, match: StepTextMatcher, compat: StateCompat): readonly Draft[] {
  if (index.states.size === 0) return [];
  const tags = pickle.tags.map((tag) => tag.name);
  const hooked = (type: HookType): boolean => compat.hooks.some((hook) => hook.type === type && applies(hook, tags));
  const afterEachLine = hooked("after_step");
  const start: StateFacts = compat.customWorld || hooked("before") ? ALL_UNKNOWN : { byHolder: new Map(), unnamed: NEVER_GIVEN };
  let facts = new Map([...index.states.keys()].map((state) => [state, start]));

  const lines = pickle.steps.map((pickleStep): Line => {
    const matched = match(pickleStep.text);
    const entry = matched.stepNames.length === 1 ? vocabulary.get(matched.stepNames[0]!) : undefined;
    if (entry === undefined || entry.kind !== "typed") return { kind: "opaque" };
    return { kind: "typed", name: entry.name, step: entry.step, captured: capturedTexts(matched.matched, pickleStep.text) };
  });
  const givenAt: { readonly stepIndex: number; readonly state: string; readonly holder: string }[] = [];
  const drafts: Draft[] = [];
  const open = new Map<string, Draft>();
  const undeclaredBetween = (from: number, to: number, state: string): readonly string[] => {
    const names = lines.slice(from, to).flatMap((line) => {
      if (line.kind !== "typed" || isClaimStep(line.step)) return [];
      const { requires, gives, ends } = line.step.states;
      return [...requires, ...gives, ...ends].some((use) => use.state === state) ? [] : [line.name];
    });
    return [...new Set(names)];
  };

  lines.forEach((line, stepIndex) => {
    if (line.kind === "typed") {
      for (const use of line.step.states.requires) {
        const info = index.states.get(use.state)!;
        if (isMismatched(info)) continue;
        const current = facts.get(use.state)!;
        const holder = holderOf(line, use);
        if (!holder.stated) {
          const nobody = current.unnamed.holds === "not-held" && [...current.byHolder.values()].every((fact) => fact.holds === "not-held");
          if (!nobody) continue;
          const cause: StateCause =
            info.givers.length === 0 ? { kind: "no-giver" } : { kind: "held-by-none", undeclared: undeclaredBetween(0, stepIndex, use.state) };
          drafts.push({ stepIndex, stepName: line.name, use, holder: undefined, cause, alsoRequiredAt: [] });
          continue;
        }
        const fact = current.byHolder.get(holder.value) ?? current.unnamed;
        if (fact.holds !== "not-held") continue;
        const foldKey = JSON.stringify([use.state, holder.value, fact.endedAt ?? null]);
        const earlier = open.get(foldKey);
        if (earlier !== undefined) {
          if (earlier.stepIndex !== stepIndex && !earlier.alsoRequiredAt.includes(stepIndex)) earlier.alsoRequiredAt.push(stepIndex);
          continue;
        }
        const ender = fact.endedAt === undefined ? undefined : lines[fact.endedAt];
        const cause: StateCause =
          info.givers.length === 0
            ? { kind: "no-giver" }
            : fact.endedAt !== undefined && ender?.kind === "typed"
              ? { kind: "ended", stepIndex: fact.endedAt, stepName: ender.name, undeclared: undeclaredBetween(fact.endedAt + 1, stepIndex, use.state) }
              : {
                  kind: "never-given",
                  givenToOthers: givenAt.filter((given) => given.state === use.state && given.holder !== holder.value),
                  undeclared: undeclaredBetween(0, stepIndex, use.state),
                };
        const draft: Draft = { stepIndex, stepName: line.name, use, holder: use.key === undefined ? undefined : holder.value, cause, alsoRequiredAt: [] };
        open.set(foldKey, draft);
        drafts.push(draft);
      }
    }
    const changes = changesOf(line, index);
    if (changes === "unknown") {
      facts = new Map([...facts.keys()].map((state) => [state, ALL_UNKNOWN]));
    } else {
      for (const change of changes) {
        facts.set(change.state, applyChange(facts.get(change.state)!, change, stepIndex));
        if (change.op === "give" && change.holder.stated && change.holder.value !== "") {
          givenAt.push({ stepIndex, state: change.state, holder: change.holder.value });
        }
      }
    }
    if (afterEachLine) facts = new Map([...facts.keys()].map((state) => [state, ALL_UNKNOWN]));
  });
  return drafts;
}

/** `also` labels the lines folded into the finding, and `last` the last of
 * them, or the requiring line when none is, or nothing when they lie in
 * more than one scenario. */
function render(
  draft: Draft,
  at: (stepIndex: number) => string,
  pickle: Pickle,
  index: StateIndex,
  also: readonly string[],
  last: string | undefined,
): { readonly message: string; readonly fix: string } {
  return { message: stateMissingMessage(draft, at, pickle, also), fix: stateMissingFix(draft, at, index, last) };
}

function listed(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

function stateMissingMessage(draft: Draft, at: (stepIndex: number) => string, pickle: Pickle, also: readonly string[]): string {
  const { use, holder, cause, stepIndex } = draft;
  const subject =
    use.key === undefined
      ? `Step "${draft.stepName}" requires "${use.state}"`
      : holder === undefined
        ? `Step "${draft.stepName}" requires "${use.state}" for a ${use.key} this line does not name`
        : `Step "${draft.stepName}" requires "${use.state}" for ${use.key} "${holder}"`;
  let reason: string;
  switch (cause.kind) {
    case "no-giver":
      reason = "no step gives it, so no line can";
      break;
    case "ended":
      reason = `${at(cause.stepIndex)} "${pickle.steps[cause.stepIndex]?.text ?? ""}" (step "${cause.stepName}") ends it, with no line between them giving it again`;
      break;
    case "held-by-none":
      reason = `by what the earlier lines declare, no ${use.key ?? "holder"} holds it here`;
      break;
    case "never-given": {
      if (stepIndex === 0) {
        reason = `no earlier line gives it: ${at(0)} is the scenario's first line`;
        break;
      }
      const others = cause.givenToOthers.map((given) => `${at(given.stepIndex)} gives it to ${given.holder}`);
      reason = `no earlier line gives it${holder === undefined ? "" : ` to ${holder}`}${others.length > 0 ? `: ${listed(others)}` : ""}`;
      break;
    }
  }
  return `${subject}, and ${reason}${alsoRequired(also)}. nuka run refuses this scenario before any of its steps runs`;
}

/** "; line 12 requires it too", "; lines 12 and 17 require it too". */
function alsoRequired(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return `; ${labels[0]} requires it too`;
  const numbers = labels.every((label) => label.startsWith("line ")) ? labels.map((label) => label.slice("line ".length)) : undefined;
  return `; ${numbers === undefined ? listed(labels) : `lines ${listed(numbers)}`} require it too`;
}

function stateMissingFix(draft: Draft, at: (stepIndex: number) => string, index: StateIndex, last: string | undefined): string {
  const { use, holder, cause, stepIndex } = draft;
  const ref = use.key === undefined ? `"${use.state}"` : `["${use.state}", "<key>"]`;
  if (cause.kind === "no-giver") {
    const given = [...index.states].filter(([, info]) => info.givers.length > 0).map(([state]) => state);
    const known = given.length === 0 ? "No step gives a state yet." : `The states steps give: ${quoted(given)}.`;
    return `Add ${ref} to the gives of the step that leaves it holding, or correct the name in the requires of step "${draft.stepName}". ${known}`;
  }
  const givers = index.states.get(use.state)!.givers.map((giver) => {
    const filled = new Map(holder !== undefined && giver.key !== undefined ? [[giver.key, holder]] : []);
    return `"${giver.name}" ("${exampleLine(giver.pattern, filled)}")`;
  });
  const runs = givers.length === 1 ? `step ${givers[0]}` : `one of steps ${givers.join(", ")}`;
  const put =
    cause.kind === "ended"
      ? `Put a line that runs ${runs} between ${at(cause.stepIndex)} and ${at(stepIndex)}${last === undefined ? "" : `, or move ${at(cause.stepIndex)} below ${last}`}.`
      : `Put a line that runs ${runs} before ${at(stepIndex)}.`;
  const undeclared =
    cause.undeclared.length === 0
      ? ""
      : cause.undeclared.length === 1
        ? ` Or, if step "${cause.undeclared[0]}" gives "${use.state}" without saying so, add ${ref} to its gives.`
        : ` Or, if one of steps ${quoted(cause.undeclared)} gives "${use.state}" without saying so, add ${ref} to that step's gives.`;
  return `${put}${undeclared} If the scenario means to show what happens without "${use.state}", the line needs a step that does not require it.`;
}

/** Every state some steps name with a key and others without, in the
 * order the vocabulary first names it. */
export function stateShapeIssues(vocabulary: Vocabulary): readonly StateShapeIssue[] {
  return [...indexOf(vocabulary).states].flatMap(([state, info]) => {
    if (!isMismatched(info)) return [];
    const steps = (names: readonly string[]): string => (names.length === 1 ? `step "${names[0]}"` : `steps ${quoted(names)}`);
    return [
      {
        state,
        keyed: info.keyed,
        unkeyed: info.unkeyed,
        message: `State "${state}" has a holder key in ${steps(info.keyed)} and none in ${steps(info.unkeyed)}, so no line that requires it is judged`,
        fix: `Write "${state}" the same way in every step: ["${state}", "<key>"] in each requires, gives, and ends entry, or the bare name in all of them.`,
      },
    ];
  });
}
