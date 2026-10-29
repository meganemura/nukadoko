import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { installChannelPatches } from "../src/context/channels.js";
import { createStepContext } from "../src/context/create-context.js";
import { createEventsReader, type EventsReader } from "../src/context/events-file.js";
import { EVENTS_READ_FILE_NAME, readEvents, type EventsProducer, type EventsRequest } from "../src/context/events-read.js";
import type { StampedBoundaryTrace } from "../src/context/observed.js";
import type { EventSelection } from "../src/execution-events/selection.js";
import type { EventsReadRecord, EventsSlice } from "../src/record/types.js";
import type { SecretSet } from "../src/secrets/types.js";
import { JOBS, PREFIX, REQUEST_ID, render, SPANS, T, traceparent, TX_IDS, U, type Op } from "./helpers/event-lines.js";

// Responsibility: a claim step's reading of an earlier step's execution
// events (src/context/events-read.ts). It reads from where the producer's
// slice began, waits while more lines can make the producer's events
// whole and no longer, widens a count by each line no step owns that may
// be the producer's, keeps a kind the world never reported from making an
// absence hold, writes exactly the lines it counted, and reads a finished
// record the same way. Its counts do not depend on where another step's
// lines fall between the producer's, nor on where the file was cut while
// the program wrote it.

/** A trace no step of the world owns: a request nukadoko did not stamp. */
const STRANGER = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";

const OF = { step_record_id: "step-1", step: "place-score", line: 3 };

const WRITES: EventSelection = { kind: "db", op: ["insert", "update", "delete", "other"], committed: true };
const INSERTS: EventSelection = { kind: "db", table: "scores", op: "insert", committed: true };
const PERFORMS: EventSelection = { kind: "job", phase: "perform" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-events-read-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line = (trace: string, fields: Record<string, unknown>, span: string = SPANS[0]!): string => JSON.stringify({ trace: traceparent(trace, span), ...fields });
const requestLine = (trace = T, span = SPANS[0]!) => line(trace, { kind: "request", id: REQUEST_ID, method: "POST", route: "/rooms/:id/scores", status: 303 }, span);
const insertLine = (trace = T, extra: Record<string, unknown> = {}) => line(trace, { kind: "db", table: "scores", op: "insert", committed: true, ...extra });
const jobLine = (phase: "enqueue" | "perform", trace = T) => line(trace, { kind: "job", name: "ScoreRecalcJob", phase, job_id: JOBS[0] });

function trace(spans: readonly string[], over: Partial<StampedBoundaryTrace> = {}): StampedBoundaryTrace {
  return { traceId: T, stamped: spans.length, lastStampAt: undefined, spans, spansNotKept: 0, processes: 0, processSpans: [], ...over } as StampedBoundaryTrace;
}

/** An events file with `before` written, and a reader whose producer, the
 * step of trace T, began its slice after it. */
async function world(before: readonly string[] = [], producer: StampedBoundaryTrace = trace([SPANS[0]!])): Promise<{ file: string; reader: EventsReader; live: EventsProducer }> {
  const file = path.join(dir, "events.jsonl");
  writeFileSync(file, before.map((text) => `${text}\n`).join(""));
  const reader = createEventsReader(file, PREFIX, []);
  await reader.slice(path.join(dir, "producer"), producer);
  return { file, reader, live: { source: "live", of: OF, start: reader.producer(producer.traceId)!, file: reader.world } };
}

const append = (file: string, texts: readonly string[]): void => appendFileSync(file, texts.map((text) => `${text}\n`).join(""));

const requests = (producer: EventsProducer, selections: Readonly<Record<string, EventSelection>>): EventsRequest[] =>
  Object.entries(selections).map(([key, selection]) => ({ key, producer, selection }));

const read = (into: string, list: readonly EventsRequest[], waitMs = 1500, secrets: SecretSet = []) => readEvents(list, { until: Date.now() + waitMs, dir: into, secrets });

describe("readEvents from the world's file", () => {
  it("waits for the job the producer enqueued, then counts exactly", async () => {
    const { file, live } = await world();
    append(file, [insertLine(), jobLine("enqueue"), requestLine()]);
    setTimeout(() => append(file, [jobLine("perform")]), 60);
    const readings = await read(path.join(dir, "then"), requests(live, { writes: WRITES, performs: PERFORMS }));
    expect(readings.writes).toMatchObject({ of: OF, trace_id: T, range: { at_least: 1, at_most: 1 }, whole: true, open: [], lines: 4, file: EVENTS_READ_FILE_NAME });
    expect(readings.performs).toMatchObject({ range: { at_least: 1, at_most: 1 }, whole: true });
    expect(readings.writes!.waited_ms).toBeGreaterThanOrEqual(40);
    expect(readFileSync(path.join(dir, "then", EVENTS_READ_FILE_NAME), "utf8").trim().split("\n")).toHaveLength(4);
  });

  it("stops at the deadline while a job has not performed, and gives the count no upper bound", async () => {
    const { file, live } = await world();
    append(file, [jobLine("enqueue"), requestLine()]);
    const started = Date.now();
    const readings = await read(path.join(dir, "then"), requests(live, { writes: WRITES }), 200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readings.writes).toMatchObject({
      range: { at_least: 0, at_most: null },
      whole: false,
      open: [{ gap: "jobs-pending", job_ids: [JOBS[0]] }, { gap: "kind-unreported", kind: "db" }],
    });
  });

  it("does not wait for what no more lines can close", async () => {
    const { file, live } = await world([], trace([SPANS[0]!], { processes: 1, processSpans: [SPANS[2]!] }));
    append(file, [jobLine("enqueue"), requestLine()]);
    const started = Date.now();
    const readings = await read(path.join(dir, "then"), requests(live, { performs: PERFORMS }), 5000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readings.performs!.open.map((gap) => gap.gap)).toEqual(["processes-unbounded", "jobs-pending"]);
  });

  it("keeps an absence of a kind the world never reported from holding, and lets one it reported anywhere hold", async () => {
    const quiet = await world();
    append(quiet.file, [requestLine()]);
    expect((await read(path.join(dir, "quiet"), requests(quiet.live, { writes: WRITES })))).toMatchObject({
      writes: { range: { at_least: 0, at_most: null }, whole: false, open: [{ gap: "kind-unreported", kind: "db" }] },
    });
    rmSync(path.join(dir, "events.jsonl"));
    // A read in an earlier scenario, of another trace, says the program reports db lines.
    const reporting = await world([line(U, { kind: "db", table: "rooms", op: "read" })]);
    append(reporting.file, [requestLine()]);
    expect((await read(path.join(dir, "reporting"), requests(reporting.live, { writes: WRITES })))).toMatchObject({
      writes: { range: { at_least: 0, at_most: 0 }, whole: true, open: [] },
    });
  });

  it("widens a count by a line no step owns that may be the producer's, and leaves another step's lines out", async () => {
    const { file, live } = await world([insertLine(STRANGER)]);
    append(file, [requestLine(), insertLine(STRANGER, { x_note: "s3cr3t-value" }), line(STRANGER, { kind: "db", table: "rooms", op: "read" }), insertLine(U)]);
    const readings = await read(path.join(dir, "then"), requests(live, { inserts: INSERTS }), 1500, [{ name: "APP_TOKEN", value: "s3cr3t-value" }]);
    expect(readings.inserts).toMatchObject({ range: { at_least: 0, at_most: 1 }, whole: true, unowned: 2, maybe: { unowned: 1 } });
    const kept = readFileSync(path.join(dir, "then", EVENTS_READ_FILE_NAME), "utf8");
    expect(kept.trim().split("\n").map((text) => (JSON.parse(text) as { trace: string }).trace)).toEqual([traceparent(T, SPANS[0]!), traceparent(STRANGER, SPANS[0]!)]);
    expect(kept).not.toContain("s3cr3t-value");
  });

  it("says the file was replaced, and stops reading it", async () => {
    const { file, live } = await world();
    append(file, [requestLine()]);
    renameSync(file, path.join(dir, "moved.jsonl"));
    writeFileSync(file, `${insertLine()}\n`);
    const readings = await read(path.join(dir, "then"), requests(live, { writes: WRITES }));
    expect(readings.writes).toMatchObject({ whole: false, range: { at_least: 0, at_most: null } });
    expect(readings.writes!.open.map((gap) => gap.gap)).toContain("file-replaced");
  });

  it("names why nothing was read", async () => {
    const unread: EventsProducer = { source: "unread", of: null, gap: "producer-not-run" };
    const readings = await read(path.join(dir, "then"), requests(unread, { writes: WRITES }));
    expect(readings.writes).toEqual({
      of: null,
      trace_id: null,
      count: WRITES,
      range: { at_least: 0, at_most: null },
      counted: [],
      whole: false,
      open: [{ gap: "producer-not-run" }],
      maybe: { unreadable: 0, undefined_kind: 0, unknown_version: 0, field_unknown: 0, commit_unknown: 0, unowned: 0 },
      lines: 0,
      unreadable: 0,
      unowned: 0,
      file: null,
      waited_ms: 0,
    } satisfies EventsReadRecord);
    expect(existsSync(path.join(dir, "then", EVENTS_READ_FILE_NAME))).toBe(false);
  });
});

/** Ops of the producer's trace that leave its events open only for want
 * of the last line: no damage, no bare trace id, and no request the
 * producer stamped. */
const opening: gs.Generator<Op> = gs.oneOf<Op>(
  gs.just<Op>(["request", SPANS.length]),
  gs.just<Op>(["db"]),
  gs.sampledFrom(["extension", "undefined-kind", "unknown-version"] as const).map((kind): Op => [kind]),
  gs.tuples(gs.integers({ minValue: 0, maxValue: TX_IDS.length - 1 }), gs.sampledFrom(["commit", "rollback"] as const)).map(([tx, phase]): Op => ["tx", tx, phase]),
  gs.sampledFrom(["committed", "not-committed", "none", "savepoint", "transaction", "elsewhere"] as const).map((parent): Op => ["write", parent]),
  gs.integers({ minValue: 0, maxValue: JOBS.length - 1 }).map((job): Op => ["enqueue", job]),
);

/** The producer's lines: every job it enqueued performs, and the line of
 * the one request it stamped comes last, so the events are whole only
 * once the last line is in. */
function producerLines(entries: readonly Op[]): string[] {
  const texts = entries.map((entry) => render(entry, T, U, ""));
  const performs = entries.filter((entry) => entry[0] === "enqueue").map((entry) => render(["perform", entry[1] as number], T, U, ""));
  return [...texts, ...performs, requestLine()];
}

const SELECTIONS: Readonly<Record<string, EventSelection>> = {
  inserts: INSERTS,
  rolledBack: { kind: "db", table: "scores", op: "insert", committed: false },
  performs: PERFORMS,
  requests: { kind: "request" },
};

/** The readings of a world whose file gets `first`, then, a moment after
 * the reading began, `second`. A line no step owns that would widen the
 * count of inserts comes before the producer's slice began, outside its
 * window. */
async function readingOf(first: Buffer, second: Buffer): Promise<{ readonly readings: Readonly<Record<string, EventsReadRecord>>; readonly kept: string }> {
  const at = mkdtempSync(path.join(os.tmpdir(), "nukadoko-events-read-case-"));
  try {
    const file = path.join(at, "events.jsonl");
    writeFileSync(file, `${insertLine(STRANGER)}\n`);
    const reader = createEventsReader(file, PREFIX, []);
    await reader.slice(path.join(at, "producer"), trace([SPANS[0]!]));
    const live: EventsProducer = { source: "live", of: OF, start: reader.producer(T)!, file: reader.world };
    appendFileSync(file, first);
    const later = new Promise<void>((resolve) =>
      setTimeout(() => {
        appendFileSync(file, second);
        resolve();
      }, 15),
    );
    const readings = await readEvents(requests(live, SELECTIONS), { until: Date.now() + 2000, dir: path.join(at, "then"), secrets: [] });
    await later;
    const keptPath = path.join(at, "then", EVENTS_READ_FILE_NAME);
    const withoutWait = Object.fromEntries(Object.entries(readings).map(([key, value]) => [key, { ...value, waited_ms: 0 }]));
    return { readings: withoutWait, kept: existsSync(keptPath) ? readFileSync(keptPath, "utf8") : "" };
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
}

describe("readEvents' counts", () => {
  it("are the same wherever the program's writes cut the file", () =>
    hegel.testAsync(
      async (tc) => {
        const bytes = Buffer.from(producerLines(tc.draw(gs.arrays(opening, { maxSize: 8 }))).map((text) => `${text}\n`).join(""));
        const cut = tc.draw(gs.integers({ minValue: 0, maxValue: bytes.length }));
        const whole = await readingOf(bytes, Buffer.alloc(0));
        const split = await readingOf(bytes.subarray(0, cut), bytes.subarray(cut));
        expect(split).toEqual(whole);
      },
      { testCases: 40 },
    ));

  it("are the same wherever another step's lines fall between the producer's", () =>
    hegel.testAsync(
      async (tc) => {
        const own = producerLines(tc.draw(gs.arrays(opening, { maxSize: 8 })));
        const others = tc.draw(gs.arrays(opening, { maxSize: 8 })).map((entry) => render(entry, U, T, ""));
        const merged: string[] = [];
        let mine = 0;
        let theirs = 0;
        while (mine < own.length || theirs < others.length) {
          const pick = tc.draw(gs.booleans());
          if ((pick && mine < own.length) || theirs === others.length) merged.push(own[mine++]!);
          else merged.push(others[theirs++]!);
        }
        // The other step's lines are in both files, so the world reports the
        // same kinds; only where they fall differs.
        const alone = await readingOf(Buffer.from([...others, ...own].map((text) => `${text}\n`).join("")), Buffer.alloc(0));
        const among = await readingOf(Buffer.from(merged.map((text) => `${text}\n`).join("")), Buffer.alloc(0));
        expect(among).toEqual(alone);
      },
      { testCases: 40 },
    ));
});

describe("readEvents from a finished record", () => {
  function recorded(lines: readonly string[], late: readonly string[], over: Partial<EventsSlice> = {}): EventsProducer {
    const producerDir = path.join(dir, "steps", "step-1");
    mkdirSync(producerDir, { recursive: true });
    writeFileSync(path.join(producerDir, "events.jsonl"), lines.map((text) => `${text}\n`).join(""));
    if (late.length > 0) writeFileSync(path.join(producerDir, "events-late.jsonl"), late.map((text) => `${text}\n`).join(""));
    const slice: EventsSlice = {
      trace_id: T,
      lines: lines.length,
      file: "events.jsonl",
      kinds: {},
      stamped: 1,
      stamped_spans: [SPANS[0]!],
      unreadable: 0,
      unowned: 0,
      process_spans: [],
      process_requests: 0,
      whole: false,
      open: [],
      ...over,
    };
    return { source: "recorded", of: OF, dir: producerDir, slice };
  }

  it("counts the step's lines and the ones that came after its record, with no wait", async () => {
    const producer = recorded([insertLine(), jobLine("enqueue"), requestLine()], [jobLine("perform")]);
    const readings = await read(path.join(dir, "then"), requests(producer, { inserts: INSERTS, performs: PERFORMS }), 5000);
    expect(readings.inserts).toMatchObject({ range: { at_least: 1, at_most: 1 }, whole: true, lines: 4, waited_ms: 0, file: EVENTS_READ_FILE_NAME });
    expect(readings.performs).toMatchObject({ range: { at_least: 1, at_most: 1 }, whole: true });
  });

  it("widens each count by the lines no step owned in the producer's slice, and matches no request of a record without its spans", async () => {
    const widened = await read(path.join(dir, "widened"), requests(recorded([insertLine(), requestLine()], [], { unowned: 2 }), { inserts: INSERTS }));
    expect(widened.inserts).toMatchObject({ range: { at_least: 1, at_most: 3 }, whole: true, unowned: 2, maybe: { unowned: 2 } });
    const { stamped_spans: _spans, ...old } = (recorded([insertLine(), requestLine()], []) as Extract<EventsProducer, { source: "recorded" }>).slice;
    const oldProducer: EventsProducer = { source: "recorded", of: OF, dir: path.join(dir, "steps", "step-1"), slice: old };
    const readings = await read(path.join(dir, "old"), requests(oldProducer, { inserts: INSERTS }));
    expect(readings.inserts).toMatchObject({ whole: false, open: [{ gap: "request-unreported", requests: 1 }] });
  });
});

describe("a step context's events reading", () => {
  let server: Server;
  let origin: string;
  let eventsFile: string;
  beforeAll(() => {
    installChannelPatches();
  });
  beforeEach(async () => {
    eventsFile = path.join(dir, "inlet", "events.jsonl");
    mkdirSync(path.dirname(eventsFile), { recursive: true });
    writeFileSync(eventsFile, "");
    // A program that writes a score inside a transaction, enqueues a job,
    // and has the job perform a moment after the request answered.
    server = createServer((req, res) => {
      const header = req.headers.traceparent as string;
      const write = (fields: Record<string, unknown>) => appendFileSync(eventsFile, `${JSON.stringify({ trace: header, ...fields })}\n`);
      write({ kind: "db", table: "scores", op: "insert", parent: "tx1" });
      write({ kind: "job", name: "ScoreRecalcJob", phase: "enqueue", job_id: "j1" });
      write({ kind: "tx", id: "tx1", phase: "commit", parent: "req1" });
      write({ kind: "request", id: "req1", method: "POST", route: "/scores", status: 303 });
      res.end("ok");
      setTimeout(() => write({ kind: "job", name: "ScoreRecalcJob", phase: "perform", job_id: "j1" }), 400);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("reads the producer's trace from where its slice began, in the claim step's directory", async () => {
    const config = { stepTimeout: 1_200_000, browserType: "chromium", worldParameters: {} } as unknown as NukadokoConfig;
    const handle = createStepContext({ config, baseURL: origin, evidenceDir: dir, env: {}, stepTitle: "events", programLog: path.join(dir, "program.log"), events: eventsFile });
    try {
      await handle.beginStep(path.join(dir, "producer"), "producer");
      await handle.recordingProcesses(async () => (await fetch(`${origin}/scores`, { method: "POST" })).text());
      const observed = await handle.observedSnapshot();
      const traceId = observed.events!.trace_id;
      expect(observed.events).toMatchObject({ whole: false, open: [{ gap: "jobs-pending", job_ids: ["j1"] }] });
      await handle.beginStep(path.join(dir, "then"), "then");
      const producer = handle.eventsProducer(OF, traceId);
      expect(handle.eventsProducer(OF, traceId)).toBe(producer);
      const readings = await handle.readEvents(requests(producer, { inserts: INSERTS, performs: PERFORMS }), Date.now() + 3000);
      expect(readings.inserts).toMatchObject({ trace_id: traceId, range: { at_least: 1, at_most: 1 }, whole: true, lines: 5 });
      expect(readings.performs).toMatchObject({ range: { at_least: 1, at_most: 1 }, whole: true });
      expect(readFileSync(path.join(dir, "then", EVENTS_READ_FILE_NAME), "utf8").trim().split("\n")).toHaveLength(5);
      expect(handle.eventsProducer(OF, "4bf92f35ffffffffffffffffffffffff")).toMatchObject({ source: "unread", gap: "producer-not-run" });
    } finally {
      await handle.dispose();
    }
  });

  it("names a world whose program file names no {events}, and one nukadoko did not start", async () => {
    const config = { stepTitle: "x", stepTimeout: 1_200_000, browserType: "chromium", worldParameters: {} } as unknown as NukadokoConfig;
    const served = createStepContext({ config, baseURL: origin, evidenceDir: dir, env: {}, stepTitle: "a", programLog: path.join(dir, "program.log") });
    const atUrl = createStepContext({ config, baseURL: origin, evidenceDir: dir, env: {}, stepTitle: "b", programLog: null, events: null });
    try {
      expect(served.eventsProducer(OF, T)).toEqual({ source: "unread", of: OF, gap: "inlet-unnamed" });
      expect(atUrl.eventsProducer(OF, T)).toEqual({ source: "unread", of: OF, gap: "world-unread" });
    } finally {
      await served.dispose();
      await atUrl.dispose();
    }
  });
});
