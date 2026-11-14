import type { ReturnsDrop, StepRecord, UsedEntryWithResult } from "../record/types.js";
import { reviveStoredForm } from "../stored-form/revive.js";
import { producersOf, isClaimStep, malformedFromEntryMessage, tryFromCandidates, type Step } from "./define-step.js";

// Responsibility: `nuka do --use <record-id>`'s own lookup (docs/spec.md
// "Single steps (the agent path)", the `--use` paragraph) — turns one
// step record id into whichever of the step actually being run's own
// `from` keys that step record's result fills. A pure function around one
// step record id at a time, returning a result rather than throwing (same
// shape as src/step/validate-from.ts's `validateStepFrom`): `nuka do`'s own
// setup phase (src/cli/do.ts) is the thing that knows a non-`ok` result here
// means stderr + exit 1 with no step record written, not this module.
//
// `readStepRecord` and `stepNameOf` are both injected rather than built here
// — `readStepRecord` so a test can supply a fake without touching disk (the
// real one is src/record/read-step-record.ts's `readStepRecordById`, closed
// over `rootDir`/`config.stateDir` by the caller), and `stepNameOf` because
// it is the same "Step object -> the vocabulary name discovery registered it
// under" map `nuka do`'s own `isRegisteredStep` predicate is built from
// (one vocabulary walk, not two).
//
// A claim step's `events` keys match the same way: a step record whose
// step one key's `of` names supplies that key's execution events, and the
// caller reads them from the record (src/cli/recorded-events.ts). Such a
// record fills no args key, so it lands in no `used` entry. A `files` key
// matches the same way, and reads the paths the record's `runCommand`
// processes changed.
//
// A key naming several candidate producers matches this step record against
// every one of them via `fromCandidates`, exactly the way a
// single-candidate key already did — one step record can therefore still
// fill a key whose `from` lists several candidates, as long as its own step
// is one of them. What this module does *not* do is notice when two
// different `--use` values end up filling the same key from two *different*
// candidates — that cross-call comparison needs every `--use` value's own
// result side by side, which only this function's caller (src/cli/do.ts)
// has, and that is where the conflict check lives instead.

export interface ResolveUseError {
  readonly ok: false;
  readonly message: string;
}

export interface ResolveUseSuccess {
  readonly ok: true;
  /** Every args key this step record's `result` filled, keyed the same way
   * `step.from`'s own keys are — `nuka do`'s own caller still has to check
   * each key against `--args` before actually writing it in (`--args` wins
   * for a key it already set), so this is offered up unconditionally, not
   * pre-filtered. */
  readonly filled: Readonly<Record<string, unknown>>;
  /** For each key of `filled`, the key of the upstream result it was read
   * from: the step record's `args_origin`. */
  readonly sources: Readonly<Record<string, string>>;
  /** The `{ step_record_id, step, result }` shape the `used` collector
   * (src/context/used.ts) already records — handed straight to
   * `StepContextHandle.recordUsed`, the sole path into that collector, once
   * the caller decides at least one of `filled`'s keys actually landed.
   * `result` is this upstream step record's own full validated result,
   * always populated here (this function only ever reaches this point for a
   * step record whose `status` is already checked `"passed"`, above); the
   * caller strips it back off for a "passed" step record of its own the same
   * way run-scenario.ts's `finishExecutedStep` does. */
  readonly used: UsedEntryWithResult;
  /** The step this record's result came from, as this step's `from`
   * names it; `undefined` when only `events` keys name it, so it fills
   * no key. */
  readonly producer: Step | undefined;
  /** What the record says that step's `returns` dropped
   * (`returns_dropped`), `undefined` for a record that does not say. */
  readonly dropped: readonly ReturnsDrop[] | undefined;
  /** The events keys whose `of` names this step record's step. */
  readonly events: readonly string[];
  /** The files keys whose `of` names this step record's step. */
  readonly files: readonly string[];
  /** The step record itself, whose execution events those events keys
   * count and whose processes those files keys read. */
  readonly record: StepRecord;
}

export type ResolveUseResult = ResolveUseError | ResolveUseSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * A record's `returns_dropped`, or `undefined` when the record has no such
 * field or holds one of another shape: a record from before the field, or
 * one written by hand, says nothing a claim can rely on. A key name the
 * redactor rewrote is no longer the key the step returned, so its place
 * becomes one the record cannot name keys at, and a claim there is not
 * judged rather than judged against the token. Pure.
 */
export function readReturnsDropped(value: unknown): ReturnsDrop[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const drops: ReturnsDrop[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isStrings(entry.at)) return undefined;
    if (typeof entry.unmeasured === "string" && entry.keys === undefined) {
      drops.push({ at: entry.at, unmeasured: entry.unmeasured });
    } else if (isStrings(entry.keys) && entry.keys.length > 0 && entry.unmeasured === undefined) {
      // The redactor's token (src/secrets/redact.ts).
      drops.push(
        entry.keys.some((key) => key.includes("{{secret."))
          ? { at: entry.at, unmeasured: "the record names a key it dropped there only as a redacted secret" }
          : { at: entry.at, keys: entry.keys },
      );
    } else {
      return undefined;
    }
  }
  return drops;
}

/**
 * Resolves one `--use <recordId>` against `step`'s own `from` declaration.
 * Checked in this order: unknown id, a non-`"passed"` step record, the first
 * structurally malformed `from` entry this step declares (walked in key
 * order, so this can surface before the "no matching upstream" verdict
 * below even runs), a step record whose step names none of `step.from`'s
 * upstreams, then — per matching entry — a `result` missing the key that
 * entry names.
 */
export function resolveUse(
  recordId: string,
  step: Step,
  stepNameOf: ReadonlyMap<Step, string>,
  readStepRecord: (recordId: string) => StepRecord | null,
  /** Appended to the unknown-id refusal: the one case where the id may
   * have been right and the record is simply gone (src/record/
   * retention.ts's `retentionNote`). */
  missingNote?: string,
  /** Appended when no `from` upstream matched and one of them has no name
   * in `stepNameOf`: says why a caller's name source can lack a step. */
  unnamedNote?: string,
): ResolveUseResult {
  const stepRecord = readStepRecord(recordId);
  if (stepRecord === null) {
    return {
      ok: false,
      message: `--use ${recordId}: no such step record${missingNote !== undefined ? `. ${missingNote}` : ""}`,
    };
  }

  if (stepRecord.status !== "passed") {
    return {
      ok: false,
      message: `--use ${recordId}: this step record's status is "${stepRecord.status}", not "passed". A failed execution has no validated result to read`,
    };
  }

  // Entries (plural on purpose — docs/spec.md's own wording): a single
  // upstream step can be named by more than one of this step's `from` keys,
  // and one matching step record fills all of them. Each key's own
  // candidates are checked individually via `tryFromCandidates`, so a key
  // whose `from` lists several producers still matches as long as one of
  // them is this step record's own step.
  const matches: Array<readonly [key: string, upstreamKey: string, upstream: Step]> = [];
  let unnamedPlace: string | undefined;
  for (const [key, entry] of Object.entries(step.from)) {
    const candidates = tryFromCandidates(entry);
    if (candidates === null) {
      return { ok: false, message: `--use ${recordId}: ${malformedFromEntryMessage(key, entry)}` };
    }
    for (const [upstream, upstreamKey] of candidates) {
      const upstreamName = stepNameOf.get(upstream);
      if (upstreamName === undefined) unnamedPlace ??= `from.${key}`;
      if (upstreamName === stepRecord.step) {
        matches.push([key, upstreamKey, upstream]);
      }
    }
  }
  // The keys of a reading nukadoko took (`events`, `files`) whose `of`
  // names this record's step.
  const readingKeys = (option: "events" | "files", entries: Readonly<Record<string, { readonly of: Step | readonly Step[] }>>): string[] => {
    const keys: string[] = [];
    for (const [key, entry] of Object.entries(entries)) {
      for (const candidate of producersOf(entry)) {
        const candidateName = stepNameOf.get(candidate);
        if (candidateName === undefined) unnamedPlace ??= `${option}.${key}.of`;
        if (candidateName === stepRecord.step && !keys.includes(key)) keys.push(key);
      }
    }
    return keys;
  };
  const events = isClaimStep(step) ? step.events : {};
  const files = isClaimStep(step) ? step.files : {};
  const eventsKeys = readingKeys("events", events);
  const filesKeys = readingKeys("files", files);
  const readsRecord = eventsKeys.length > 0 || filesKeys.length > 0;
  // An upstream with no name may be this record's step under another
  // module instance, so "not named by any entry" would blame the wrong thing.
  if (matches.length === 0 && !readsRecord && unnamedPlace !== undefined) {
    return {
      ok: false,
      message:
        `--use ${recordId}: its step "${stepRecord.step}" cannot be matched, because the step ` +
        `\`${unnamedPlace}\` names has no name here${unnamedNote !== undefined ? `. ${unnamedNote}` : ""}`,
    };
  }
  if (matches.length === 0 && !readsRecord) {
    const readings = [...(Object.keys(events).length === 0 ? [] : ["`events`"]), ...(Object.keys(files).length === 0 ? [] : ["`files`"])];
    const places = readings.length === 0 ? "`from` entries" : `\`from\` entries or ${readings.join(" or ")} keys`;
    return {
      ok: false,
      message: `--use ${recordId}: its step "${stepRecord.step}" is not named by any of this step's ${places}`,
    };
  }

  const result = stepRecord.result;
  const filled: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  for (const [key, upstreamKey] of matches) {
    if (!isRecord(result) || !(upstreamKey in result)) {
      return {
        ok: false,
        message: `--use ${recordId}: its result has no key "${upstreamKey}", which \`from.${key}\` names`,
      };
    }
    filled[key] = result[upstreamKey];
    sources[key] = upstreamKey;
  }

  return {
    ok: true,
    // The record holds the stored form, so a bigint this step's args
    // declare arrives as its decimal string until it is revived here.
    filled: reviveStoredForm(step.args, filled, "input") as Record<string, unknown>,
    sources,
    used: { step_record_id: recordId, step: stepRecord.step, result: stepRecord.result },
    // Every match names this record's step, so the first names them all.
    producer: matches[0]?.[2],
    dropped: readReturnsDropped((stepRecord as { returns_dropped?: unknown }).returns_dropped),
    events: eventsKeys,
    files: filesKeys,
    record: stepRecord,
  };
}
