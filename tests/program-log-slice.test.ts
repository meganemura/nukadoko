import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoundaryTrace } from "../src/context/observed.js";
import { createProgramLogReader, PROGRAM_LOG_SLICE_FILE_NAME, WINDOW_CAP_BYTES } from "../src/context/program-log-slice.js";
import { traceparentOf } from "../src/context/trace-context.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: src/context/program-log-slice.ts, reading a step's
// window of program.log and writing its slice beside the step record: the
// window starts where the step began, the slice waits for a line still on
// its way only when the step stamped a request, the step's secrets are
// redacted, and a window past the cap is marked.

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const OTHER = "a1b2c3d4e5f60718";

function trace(fields: Partial<BoundaryTrace> = {}): BoundaryTrace {
  return { traceId: TRACE, spanId: SPAN, otherSpans: new Set([OTHER]), stamped: 0, lastStampAt: undefined, ...fields };
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

function sliceText(): string {
  return readFileSync(path.join(recordDir, PROGRAM_LOG_SLICE_FILE_NAME), "utf8");
}

describe("createProgramLogReader", () => {
  it("reads only what the program wrote after the step began, and writes the step's lines beside its record", async () => {
    writeFileSync(logPath, `[${traceparentOf(TRACE, SPAN)}] written before the step\n`);
    const reader = createProgramLogReader(logPath, []);
    reader.begin();
    appendFileSync(
      logPath,
      [`[${traceparentOf(TRACE, SPAN)}] GET /mine`, `[${traceparentOf(TRACE, OTHER)}] GET /previous-step`, `[trace=${TRACE}] job`, "untagged", ""].join("\n"),
    );

    const slice = await reader.slice(recordDir, trace({ stamped: 1, lastStampAt: Date.now() - 1000 }));

    expect(slice).toEqual({ lines: 2, file: PROGRAM_LOG_SLICE_FILE_NAME, stamped: 1 });
    expect(sliceText()).toBe(`[${traceparentOf(TRACE, SPAN)}] GET /mine\n[trace=${TRACE}] job\n`);
  });

  it("writes no file for a step with no line, and reads a log that does not exist yet as empty", async () => {
    const reader = createProgramLogReader(logPath, []);
    reader.begin();
    expect(await reader.slice(recordDir, trace())).toEqual({ lines: 0, file: null, stamped: 0 });
    appendFileSync(logPath, "untagged\n");
    expect(await reader.slice(recordDir, trace({ stamped: 2, lastStampAt: Date.now() - 1000 }))).toEqual({ lines: 0, file: null, stamped: 2 });
    expect(existsSync(path.join(recordDir, PROGRAM_LOG_SLICE_FILE_NAME))).toBe(false);
  });

  it("waits for a line that arrives just after a stamped request, and does not wait for a step that stamped none", async () => {
    const reader = createProgramLogReader(logPath, []);
    reader.begin();
    const late = (): NodeJS.Timeout => setTimeout(() => appendFileSync(logPath, `[${traceparentOf(TRACE, SPAN)}] late line\n`), 10);

    late();
    expect((await reader.slice(recordDir, trace({ stamped: 1, lastStampAt: Date.now() }))).lines).toBe(1);

    reader.begin();
    const timer = late();
    expect((await reader.slice(path.join(dir, "unstamped"), trace())).lines).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    clearTimeout(timer);
  });

  it("redacts the step's secrets in the slice", async () => {
    const reader = createProgramLogReader(logPath, [{ name: "API_KEY", value: "sk-invented-4410" }]);
    reader.begin();
    appendFileSync(logPath, `[${traceparentOf(TRACE, SPAN)}] key=sk-invented-4410\n`);
    await reader.slice(recordDir, trace());
    expect(sliceText()).toBe(`[${traceparentOf(TRACE, SPAN)}] key={{secret.API_KEY}}\n`);
  });

  it("reads at most the cap of one window, and says the slice comes from its first part", async () => {
    const reader = createProgramLogReader(logPath, []);
    reader.begin();
    const filler = `${"x".repeat(1023)}\n`;
    appendFileSync(logPath, `[${traceparentOf(TRACE, SPAN)}] first\n${filler.repeat(WINDOW_CAP_BYTES / filler.length)}[${traceparentOf(TRACE, SPAN)}] past the cap\n`);
    expect(await reader.slice(recordDir, trace())).toEqual({ lines: 1, file: PROGRAM_LOG_SLICE_FILE_NAME, stamped: 0, truncated: true });
    expect(sliceText()).toBe(`[${traceparentOf(TRACE, SPAN)}] first\n`);
  });
});
