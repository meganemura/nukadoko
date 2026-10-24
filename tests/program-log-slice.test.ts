import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoundaryTrace } from "../src/context/observed.js";
import {
  collectLateLines,
  createProgramLogReader,
  PROGRAM_LOG_LATE_FILE_NAME,
  PROGRAM_LOG_SLICE_FILE_NAME,
  SLICE_CAP_BYTES,
} from "../src/context/program-log-slice.js";
import { traceparentOf } from "../src/context/trace-context.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: src/context/program-log-slice.ts, the lines of
// program.log that belong to a step: the slice a step writes beside its
// record from the lines that carry its trace id, the wait for a line still
// on its way only when the step stamped a request, the step's secrets
// redacted, the cap, and the world's stop that writes each step's lines
// that came after its slice to its program-log-late.txt.

const PREFIX = "4bf92f35";
const MINE = `${PREFIX}77b34da6a3ce929d0e0e4736`;
const PREVIOUS = `${PREFIX}0123456789abcdef01234567`;
const HOOK = `${PREFIX}fedcba9876543210fedcba98`;
const SPAN = "00f067aa0ba902b7";

function trace(fields: Partial<BoundaryTrace> = {}): BoundaryTrace {
  return { traceId: MINE, stamped: 0, lastStampAt: undefined, ...fields };
}

let dir: string;
let logPath: string;
let recordDir: string;

beforeEach(async () => {
  dir = await createEmptyTempDir();
  logPath = path.join(dir, "program.log");
  recordDir = path.join(dir, "record");
});

afterEach(async () => {
  await removeTempDir(dir);
});

function fileText(name: string, at = recordDir): string {
  return readFileSync(path.join(at, name), "utf8");
}

describe("createProgramLogReader", () => {
  it("reads what the program wrote after the reader was made, and keeps the lines that carry the step's trace id", async () => {
    writeFileSync(logPath, `[${traceparentOf(MINE, SPAN)}] written before the reader\n`);
    const reader = createProgramLogReader(logPath, PREFIX, []);
    appendFileSync(
      logPath,
      [
        `[${traceparentOf(MINE, SPAN)}] GET /mine`,
        `[${traceparentOf(PREVIOUS, SPAN)}] GET /previous-step, answered late`,
        `{"trace_id":"${MINE}","span_id":"5f2c1b0a9e8d7c6b","msg":"query"}`,
        "untagged",
        "",
      ].join("\n"),
    );

    const slice = await reader.slice(recordDir, trace({ stamped: 1, lastStampAt: Date.now() - 1000 }));

    expect(slice).toEqual({ trace_id: MINE, lines: 2, file: PROGRAM_LOG_SLICE_FILE_NAME, stamped: 1 });
    expect(fileText(PROGRAM_LOG_SLICE_FILE_NAME)).toBe(
      `[${traceparentOf(MINE, SPAN)}] GET /mine\n{"trace_id":"${MINE}","span_id":"5f2c1b0a9e8d7c6b","msg":"query"}\n`,
    );
  });

  it("writes no file for a step with no line, and reads a log that does not exist yet as empty", async () => {
    const reader = createProgramLogReader(logPath, PREFIX, []);
    expect(await reader.slice(recordDir, trace())).toEqual({ trace_id: MINE, lines: 0, file: null, stamped: 0 });
    appendFileSync(logPath, "untagged\n");
    expect(await reader.slice(recordDir, trace({ stamped: 2, lastStampAt: Date.now() - 1000 }))).toEqual({
      trace_id: MINE,
      lines: 0,
      file: null,
      stamped: 2,
    });
    expect(existsSync(path.join(recordDir, PROGRAM_LOG_SLICE_FILE_NAME))).toBe(false);
  });

  it("waits for a line that arrives just after a stamped request, and does not wait for a step that stamped none", async () => {
    const reader = createProgramLogReader(logPath, PREFIX, []);
    const late = (id: string): NodeJS.Timeout => setTimeout(() => appendFileSync(logPath, `[${traceparentOf(id, SPAN)}] late line\n`), 10);

    late(MINE);
    expect((await reader.slice(recordDir, trace({ stamped: 1, lastStampAt: Date.now() }))).lines).toBe(1);

    const timer = late(PREVIOUS);
    expect((await reader.slice(path.join(dir, "unstamped"), trace({ traceId: PREVIOUS }))).lines).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    clearTimeout(timer);
  });

  it("redacts the step's secrets in the slice", async () => {
    const reader = createProgramLogReader(logPath, PREFIX, [{ name: "API_KEY", value: "sk-invented-4410" }]);
    appendFileSync(logPath, `[${traceparentOf(MINE, SPAN)}] key=sk-invented-4410\n`);
    await reader.slice(recordDir, trace());
    expect(fileText(PROGRAM_LOG_SLICE_FILE_NAME)).toBe(`[${traceparentOf(MINE, SPAN)}] key={{secret.API_KEY}}\n`);
  });

  it("holds the step's lines up to the cap, counts them all, and says the file holds the first of them", async () => {
    const reader = createProgramLogReader(logPath, PREFIX, []);
    const line = `[${traceparentOf(MINE, SPAN)}] ${"x".repeat(1024 - 60)}`;
    const fits = Math.floor(SLICE_CAP_BYTES / (line.length + 1));
    appendFileSync(logPath, `${line}\n`.repeat(fits + 2));
    expect(await reader.slice(recordDir, trace())).toEqual({ trace_id: MINE, lines: fits + 2, file: PROGRAM_LOG_SLICE_FILE_NAME, stamped: 0, truncated: true });
    expect(fileText(PROGRAM_LOG_SLICE_FILE_NAME)).toBe(`${line}\n`.repeat(fits));
  });
});

describe("collectLateLines", () => {
  it("writes each step's lines past its slice to its late file, redacted, and counts every line that carries a trace id of the world", () => {
    const previousDir = path.join(dir, "previous");
    writeFileSync(
      logPath,
      [
        `[${traceparentOf(HOOK, SPAN)}] Before hook`,
        `[${traceparentOf(PREVIOUS, SPAN)}] Started GET /slow`,
        `[${traceparentOf(MINE, SPAN)}] Started GET /fast`,
        "untagged",
        `[${traceparentOf(PREVIOUS, SPAN)}] Completed 200 key=sk-invented-4410`,
        `[${traceparentOf(MINE, SPAN)}] Completed 200`,
        "",
      ].join("\n"),
    );

    const found = collectLateLines(
      logPath,
      PREFIX,
      [
        { traceId: PREVIOUS, lines: 1, dir: previousDir },
        { traceId: MINE, lines: 2, dir: recordDir },
      ],
      [{ name: "API_KEY", value: "sk-invented-4410" }],
    );

    expect(found.tagged).toBe(5);
    expect([...found.late]).toEqual([[PREVIOUS, { lines: 1, file: PROGRAM_LOG_LATE_FILE_NAME }]]);
    expect(fileText(PROGRAM_LOG_LATE_FILE_NAME, previousDir)).toBe(`[${traceparentOf(PREVIOUS, SPAN)}] Completed 200 key={{secret.API_KEY}}\n`);
    expect(existsSync(path.join(recordDir, PROGRAM_LOG_LATE_FILE_NAME))).toBe(false);
  });

  it("counts no tagged line in a log that carries none, and finds nothing in a log that does not exist", () => {
    writeFileSync(logPath, `GET /rooms ${traceparentOf("a1b2c3d477b34da6a3ce929d0e0e4736", SPAN)}\nuntagged\n`);
    expect(collectLateLines(logPath, PREFIX, [{ traceId: MINE, lines: 0, dir: recordDir }], [])).toEqual({ tagged: 0, late: new Map() });
    expect(collectLateLines(path.join(dir, "missing.log"), PREFIX, [{ traceId: MINE, lines: 0, dir: recordDir }], [])).toEqual({
      tagged: 0,
      late: new Map(),
    });
  });
});

// A log written in arbitrary byte pieces while steps run one after
// another, each slicing what it has read when it ends, then the world's
// stop. A step's lines can only follow the end of the step before it,
// since its trace id is made when its boundary opens; an earlier step's
// lines can come at any time after. Whatever the pieces and wherever each
// step ended, every line ends up in the files of the step whose id it
// carries, once, in log order, and a line that carries no step's id in
// none.
const STEPS = [MINE, PREVIOUS, HOOK, `${PREFIX}aaaaaaaaaaaaaaaaaaaaaaaa`];
const head = gs.sampledFrom(["GET /", "Completed 200 ", "é漢 ", ""]);
const tail = gs.sampledFrom(["", " ms=3", " 🙂"]);

function render(owner: number, before: string, after: string): string {
  if (owner === -1) return `${before}untagged${after}`;
  if (owner === -2) return `${before}${traceparentOf("a1b2c3d477b34da6a3ce929d0e0e4736", SPAN)}${after}`;
  return `${before}[${traceparentOf(STEPS[owner]!, SPAN)}]${after}`;
}

function linesOf(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(0, -1) : [];
}

describe("attribution", () => {
  it("gives every line to the step whose trace id it carries, at most one, whenever it was read and however the log was split", () =>
    hegel.testAsync(
      async (tc) => {
        const root = mkdtempSync(path.join(os.tmpdir(), "nukadoko-slice-"));
        try {
          const log = path.join(root, "program.log");
          // Each step's group: lines written while it runs or after, which
          // carry its id, an earlier step's, another world's, or none.
          const groups = STEPS.map((_, step) =>
            tc
              .draw(gs.arrays(gs.tuples(gs.integers({ minValue: -2, maxValue: step }), head, tail), { maxSize: 4 }))
              .map(([owner, before, after]) => render(owner, before, after)),
          );
          const written = groups.flat();
          const starts = groups.map((_, step) => Buffer.byteLength(groups.slice(0, step).flat().map((line) => `${line}\n`).join("")));
          const bytes = Buffer.from(written.map((line) => `${line}\n`).join(""));
          // Where each step ends: no earlier than the step before it, and
          // no later than the start of the next step's group.
          const ends: number[] = [];
          for (let step = 0; step < STEPS.length; step += 1) {
            const low = step === 0 ? 0 : ends[step - 1]!;
            const high = step + 1 < STEPS.length ? starts[step + 1]! : bytes.length;
            ends.push(tc.draw(gs.integers({ minValue: low, maxValue: high })));
          }
          const cuts = [...new Set([...tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: bytes.length }), { maxSize: 6 })), ...ends, bytes.length])].sort(
            (a, b) => a - b,
          );
          writeFileSync(log, "");
          const reader = createProgramLogReader(log, PREFIX, []);
          const sliced = new Map<string, number>();
          let at = 0;
          let step = 0;
          for (const cut of cuts) {
            appendFileSync(log, bytes.subarray(at, cut));
            at = cut;
            while (step < STEPS.length && ends[step] === cut) {
              const slice = await reader.slice(path.join(root, `step-${step}`), { traceId: STEPS[step]!, stamped: 0, lastStampAt: undefined });
              sliced.set(STEPS[step]!, slice.lines);
              step += 1;
            }
          }
          const traced = STEPS.map((traceId, index) => ({ traceId, lines: sliced.get(traceId)!, dir: path.join(root, `step-${index}`) }));
          const found = collectLateLines(log, PREFIX, traced, []);

          STEPS.forEach((traceId, index) => {
            const stepDir = path.join(root, `step-${index}`);
            const own = written.filter((line) => line.includes(traceId));
            const got = [...linesOf(path.join(stepDir, PROGRAM_LOG_SLICE_FILE_NAME)), ...linesOf(path.join(stepDir, PROGRAM_LOG_LATE_FILE_NAME))];
            expect(got).toEqual(own);
            expect(found.late.get(traceId)?.lines ?? 0).toBe(own.length - sliced.get(traceId)!);
          });
          expect(found.tagged).toBe(written.filter((line) => STEPS.some((traceId) => line.includes(traceId))).length);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      { testCases: 60 },
    ));
});
