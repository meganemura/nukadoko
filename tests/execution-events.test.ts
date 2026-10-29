import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEventsReader } from "../src/context/events-file.js";
import { parseEventLine, type ReadableLine } from "../src/execution-events/format.js";
import { createTraceTally } from "../src/execution-events/tally.js";
import { JOBS, op, PREFIX, render, SPANS, T, U } from "./helpers/event-lines.js";

// Responsibility: what the lines of one trace add up to
// (src/execution-events/tally.ts), and the step reader built on it
// (src/context/events-file.ts). A step's reading depends only on the lines
// whose parsed `trace` is its own, never on where another trace's lines
// fall between them or on which values of those lines name it; and the
// order lines of one trace arrive in, which is write order across
// processes, changes nothing a reading says.

/** The slice a step that stamped `spans` reads of a file holding `texts`. */
async function sliceOf(dir: string, texts: readonly string[], spans: readonly string[]): Promise<{ readonly slice: unknown; readonly kept: string | null }> {
  const file = path.join(dir, "events.jsonl");
  writeFileSync(file, "");
  const reader = createEventsReader(file, PREFIX, []);
  appendFileSync(file, texts.map((text) => `${text}\n`).join(""));
  const stepDir = path.join(dir, "step");
  const { unowned: _unowned, ...slice } = await reader.slice(stepDir, { traceId: T, stamped: spans.length, lastStampAt: undefined, spans, spansNotKept: 0 });
  const kept = path.join(stepDir, "events.jsonl");
  return { slice, kept: existsSync(kept) ? readFileSync(kept, "utf8") : null };
}

async function withDirAsync<Result>(run: (dir: string) => Promise<Result>): Promise<Result> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-events-test-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("reading a step's events", () => {
  it("gives a step the same reading and the same kept lines wherever another trace's lines fall, and whatever of its values name the step", () =>
    hegel.testAsync(async (tc) => {
      const spans = SPANS.slice(0, tc.draw(gs.integers({ minValue: 0, maxValue: SPANS.length })));
      const own = tc.draw(gs.arrays(op, { maxSize: 10 })).map((entry) => render(entry, T, U, ""));
      const others = tc.draw(gs.arrays(op, { maxSize: 10 })).map((entry) => render(entry, U, T, ""));
      const picks = tc.draw(gs.arrays(gs.booleans(), { minSize: own.length + others.length, maxSize: own.length + others.length }));
      const merged: string[] = [];
      let mine = 0;
      let theirs = 0;
      for (const pick of picks) {
        if ((pick && mine < own.length) || theirs === others.length) merged.push(own[mine++]!);
        else merged.push(others[theirs++]!);
      }
      const alone = await withDirAsync((dir) => sliceOf(dir, own, spans));
      const among = await withDirAsync((dir) => sliceOf(dir, merged, spans));
      expect(among).toEqual(alone);
    }));
});

describe("createTraceTally", () => {
  const readable = (text: string): ReadableLine | undefined => {
    const line = parseEventLine(text);
    return line.state === "unreadable" ? undefined : line;
  };

  function fold(texts: readonly string[], spans: readonly string[]) {
    const tally = createTraceTally({ spans, spansNotKept: 0 });
    for (const text of texts) {
      const line = readable(text);
      if (line === undefined) tally.damaged();
      else tally.owned(line);
    }
    return tally.reading({ truncated: false, replaced: false });
  }

  it("says the same in any order the lines arrive, since processes append in write order", () =>
    hegel.test((tc) => {
      const spans = SPANS.slice(0, tc.draw(gs.integers({ minValue: 0, maxValue: SPANS.length })));
      const texts = tc.draw(gs.arrays(op, { maxSize: 10 })).map((entry) => render(entry, T, U, ""));
      const shuffled = [...texts];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = tc.draw(gs.integers({ minValue: 0, maxValue: index }));
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
      }
      const inOrder = fold(texts, spans);
      const reordered = fold(shuffled, spans);
      expect({ ...reordered, open: reordered.open.map((gap) => ("job_ids" in gap ? { ...gap, job_ids: [...gap.job_ids].sort() } : gap)) }).toEqual({
        ...inOrder,
        open: inOrder.open.map((gap) => ("job_ids" in gap ? { ...gap, job_ids: [...gap.job_ids].sort() } : gap)),
      });
    }));

  it("is whole exactly when every stamped request reported, every job performed, and no line was damaged", () =>
    hegel.test((tc) => {
      const spans = SPANS.slice(0, tc.draw(gs.integers({ minValue: 1, maxValue: SPANS.length })));
      const entries = tc.draw(gs.arrays(op, { maxSize: 12 }));
      const reading = fold(
        entries.map((entry) => render(entry, T, U, "")),
        spans,
      );
      const requests = entries.filter((entry) => entry[0] === "request").map(([, span]) => span as number);
      const reported = new Set(requests.filter((span) => span >= 0 && span < spans.length)).size + requests.filter((span) => span === -1).length;
      const jobsDone = JOBS.every((_, job) => {
        const count = (phase: string) => entries.filter((entry) => entry[0] === phase && entry[1] === job).length;
        return count("perform") >= count("enqueue");
      });
      const damaged = entries.some((entry) => entry[0] === "damaged");
      expect(reading.whole).toBe(reported >= spans.length && jobsDone && !damaged);
    }));

  it("names each gap in the record's order, with the requests and the jobs still open", () => {
    const lines = [
      render(["enqueue", 0], T, U, ""),
      render(["enqueue", 1], T, U, ""),
      render(["perform", 1], T, U, ""),
      render(["request", 0], T, U, ""),
      render(["damaged"], T, U, ""),
    ];
    const tally = createTraceTally({ spans: SPANS, spansNotKept: 2 });
    for (const text of lines) {
      const line = readable(text);
      if (line === undefined) tally.damaged();
      else tally.owned(line);
    }
    expect(tally.reading({ truncated: true, replaced: true })).toEqual({
      lines: 4,
      kinds: { job: 3, request: 1 },
      unreadable: 1,
      whole: false,
      open: [
        { gap: "request-unreported", requests: 4 },
        { gap: "jobs-pending", job_ids: [JOBS[0]] },
        { gap: "unreadable", lines: 1 },
        { gap: "truncated" },
        { gap: "file-replaced" },
      ],
    });
    expect(createTraceTally({ spans: [SPANS[0]!], spansNotKept: 0 }).reading({ truncated: false, replaced: false }).open).toEqual([{ gap: "no-lines" }]);
    expect(createTraceTally({ spans: [], spansNotKept: 0 }).reading({ truncated: false, replaced: false })).toEqual({
      lines: 0,
      kinds: {},
      unreadable: 0,
      whole: false,
      open: [{ gap: "producer-unstamped" }],
    });
  });
});
