import { readFileSync } from "node:fs";
import path from "node:path";
import type { ClaimItemDeclaration, ClaimRecord, KeptText, MeasuredChannel, ObservedCounts, StepRecord } from "../record/types.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { deepEqual, type ExpectedOrigin, type JudgedClaim } from "../step/evaluate-claims.js";

// Responsibility: the `measured` field of each claim record (docs/spec.md
// "Claims"): which recorded channel of which step record holds exactly the
// raw value a claim read. A claim that reads a `from` value looks in the
// record of the step that returned it; a claim that reads `observe` looks
// in the claim step's own channels. The channels are what the step record
// holds with its content: a process's stdout, stderr, and exit code, an
// HTTP response's status and body, and a changed file's content. A number
// channel (an exit code, a status) matches only a number, so a constant
// `0` in step code is not taken for an exit code. A number that another
// channel of the same record also holds (a second exit code, or the
// number written in an output, such as a line number in a JSON report
// beside an exit code of the same value) names no channel: content alone
// cannot tell which one the value came from, and `null` says less than a
// source that may be false. `measured` is
// information for a reader of the record, never a condition of the claim,
// so a channel that cannot be read is skipped without a word.
//
// An expected value an earlier step returned or `observe` read gets the
// same search (`expected_measured`): a When step that returns a constant
// for the Then to compare with fills the expected side as surely as a
// constant in `observe` fills the actual side, and the record shows both
// the same way. A value the sentence states or a literal is in the
// feature, so no channel is looked for. The search skips the channel the
// actual value matched: a claim whose two sides are one channel compares
// that channel with itself, so a constant equal to it (an expected exit
// code of 0 beside a process that exited 0) is `null` as a constant
// should be, and another channel with the same content is still found.

/** One recorded channel and where it sits in its step record: a text, or
 * a number the record holds as a number. */
export type ChannelText =
  | { readonly channel: string; readonly text: string }
  | { readonly channel: string; readonly number: number };

/** What `recordedChannels` reads from a step record. */
export interface ChannelSource {
  readonly observed: ObservedCounts;
  /** The step record's directory, absolute: process output and http.jsonl
   * are files in it. */
  readonly dir: string;
  readonly http?: string;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function keptText(kept: KeptText | undefined): string | null {
  return kept?.text !== undefined && kept.truncated !== true && kept.incomplete !== true ? kept.text : null;
}

/** Every channel of one step record whose whole content is on disk, in
 * record order: processes, then HTTP responses, then files. */
export function recordedChannels(source: ChannelSource): readonly ChannelText[] {
  const channels: ChannelText[] = [];
  (source.observed.processes ?? []).forEach((entry, index) => {
    for (const stream of ["stdout", "stderr"] as const) {
      const file = entry[stream];
      const text = file === undefined ? null : readText(path.join(source.dir, file));
      if (text !== null) channels.push({ channel: `observed.processes[${index}].${stream}`, text });
    }
    // A process a signal ended has no exit code to have measured.
    if (typeof entry.exit_code === "number") channels.push({ channel: `observed.processes[${index}].exit_code`, number: entry.exit_code });
  });
  if (source.http !== undefined) {
    const lines = (readText(path.join(source.dir, source.http)) ?? "").split("\n").filter((line) => line.length > 0);
    lines.forEach((line, index) => {
      try {
        const parsed = JSON.parse(line) as { status?: unknown; response_body?: KeptText };
        // Status 0 is a request that got no response, not a status the
        // server answered with.
        if (typeof parsed.status === "number" && parsed.status !== 0) channels.push({ channel: `http.jsonl[${index}].status`, number: parsed.status });
        const text = keptText(parsed.response_body);
        if (text !== null) channels.push({ channel: `http.jsonl[${index}].response_body`, text });
      } catch {
        // A line that does not parse holds no body to compare.
      }
    });
  }
  (source.observed.files ?? []).forEach((entry, index) => {
    const text = keptText(entry.content);
    if (text !== null) channels.push({ channel: `observed.files[${index}].content`, text });
  });
  return channels;
}

/** Whether a recorded channel is the raw value. A number channel is the
 * same number. A text is the same string, or, for a value that is not a
 * string, the JSON the text parses to; both sides are compared redacted,
 * since the record holds only redacted text. */
function sameContent(raw: unknown, channel: ChannelText, secrets: SecretSet): boolean {
  if ("number" in channel) return typeof raw === "number" && raw === channel.number;
  const text = channel.text;
  if (typeof raw === "string") return redactString(raw, secrets) === text;
  if (raw === undefined) return false;
  try {
    return deepEqual(JSON.parse(redactString(JSON.stringify(raw), secrets)), JSON.parse(text));
  } catch {
    return false;
  }
}

/** Whether a channel holds `n` as a whole: a number channel that is `n`,
 * or a text with `n` written as a number of its own (`"line":1`, `1 file`),
 * not as part of another (`12`, `1.5`, `v1`). Pure. */
export function holdsNumber(channel: ChannelText, n: number): boolean {
  if ("number" in channel) return channel.number === n;
  const written = String(n).replace(/[.+-]/g, (char) => `\\${char}`);
  return new RegExp(`(?<![\\w.-])${written}(?![\\w.])`).test(channel.text);
}

/** Where a claim's raw actual value was measured, given the claim step's
 * own channels and a way to read the channels of the step record a `from`
 * key was filled from. */
export interface MeasuredContext {
  readonly ownRecordId: string;
  readonly ownChannels: readonly ChannelText[];
  /** The step record id a `from` key was filled from, or `null` when the
   * key was filled another way on this line. */
  readonly fromRecordOf: (key: string) => string | null;
  readonly channelsOf: (stepRecordId: string) => readonly ChannelText[];
  readonly secrets: SecretSet;
}

/** The judged claims as the step record carries them, each with the
 * channel its raw actual value equals, or `null`, and each expected value
 * an earlier step returned or `observe` read with the channel it equals. */
export function withMeasured(judged: readonly JudgedClaim[], context: MeasuredContext): ClaimRecord[] {
  const cache = new Map<string, readonly ChannelText[]>();
  const channelsOf = (id: string): readonly ChannelText[] => {
    if (id === context.ownRecordId) return context.ownChannels;
    let channels = cache.get(id);
    if (channels === undefined) {
      channels = context.channelsOf(id);
      cache.set(id, channels);
    }
    return channels;
  };
  const channelFor = (recordId: string | null, raw: unknown, skip: MeasuredChannel | null = null): MeasuredChannel | null => {
    if (recordId === null) return null;
    const skipped = (channel: ChannelText): boolean => skip !== null && skip.step_record_id === recordId && skip.channel === channel.channel;
    const channels = channelsOf(recordId).filter((channel) => !skipped(channel));
    const match = channels.find((channel) => sameContent(raw, channel, context.secrets));
    if (match === undefined) return null;
    if (typeof raw === "number" && channels.some((channel) => channel !== match && holdsNumber(channel, raw))) return null;
    return { step_record_id: recordId, channel: match.channel };
  };
  // A claim that read nothing has no expected value to have measured
  // either, and an origin of `null` is a value the feature states.
  const withExpected = <T extends { readonly expected?: unknown }>(entry: T, origin: ExpectedOrigin | undefined, measured: MeasuredChannel | null, observed: boolean): T => {
    if (!observed || origin === null || origin === undefined) return entry;
    const recordId = origin === "observe" ? context.ownRecordId : context.fromRecordOf(origin.fromKey);
    return { ...entry, expected_measured: Object.hasOwn(entry, "expected") ? channelFor(recordId, entry.expected, measured) : null };
  };
  return judged.map(({ record, rawActual, fromKey, expectedOrigins }) => {
    const observed = record.outcome !== "unobserved";
    const measured = observed ? channelFor(fromKey === null ? context.ownRecordId : context.fromRecordOf(fromKey), rawActual) : null;
    if (!("each" in record)) return { ...withExpected(record, expectedOrigins[0], measured, observed), measured };
    const where = record.each.where ?? [];
    const declared = (entry: ClaimItemDeclaration, index: number): ClaimItemDeclaration => withExpected(entry, expectedOrigins[index], measured, observed);
    return {
      ...record,
      each: {
        ...record.each,
        ...(record.each.where === undefined ? {} : { where: where.map((entry, index) => declared(entry, index)) }),
        claims: record.each.claims.map((entry, index) => declared(entry, where.length + index)),
      },
      measured,
    };
  });
}

/** Every channel of a step record already written, read from the
 * directory its `evidence.dir` names under `rootDir`. */
export function channelsOfStepRecord(rootDir: string, record: StepRecord): readonly ChannelText[] {
  return recordedChannels({
    observed: record.observed,
    dir: path.join(rootDir, record.evidence.dir),
    ...(record.evidence.http === undefined ? {} : { http: record.evidence.http }),
  });
}
