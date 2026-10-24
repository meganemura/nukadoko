import { readFileSync } from "node:fs";
import path from "node:path";
import type { ClaimRecord, KeptText, MeasuredChannel, ObservedCounts, StepRecord } from "../record/types.js";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { deepEqual, type JudgedClaim } from "../step/evaluate-claims.js";

// Responsibility: the `measured` field of each claim record (docs/spec.md
// "Claims"): which recorded channel of which step record holds exactly the
// raw value a claim read. A claim that reads a `from` value looks in the
// record of the step that returned it; a claim that reads `observe` looks
// in the claim step's own channels. The channels are what the step record
// holds with its content: a process's stdout, stderr, and exit code, an
// HTTP response's status and body, and a changed file's content. A number
// channel (an exit code, a status) matches only a number, so a constant
// `0` in step code is not taken for an exit code. `measured` is
// information for a reader of the record, never a condition of the claim,
// so a channel that cannot be read is skipped without a word.

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
 * channel its raw actual value equals, or `null`. */
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
  return judged.map(({ record, rawActual, fromKey }) => {
    const recordId = fromKey === null ? context.ownRecordId : context.fromRecordOf(fromKey);
    let measured: MeasuredChannel | null = null;
    if (recordId !== null && record.outcome !== "unobserved") {
      const match = channelsOf(recordId).find((channel) => sameContent(rawActual, channel, context.secrets));
      if (match !== undefined) measured = { step_record_id: recordId, channel: match.channel };
    }
    return { ...record, measured };
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
