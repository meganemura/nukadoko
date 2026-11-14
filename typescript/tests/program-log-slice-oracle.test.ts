import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectLateLines, createProgramLogReader, PROGRAM_LOG_LATE_FILE_NAME, PROGRAM_LOG_SLICE_FILE_NAME } from "../src/context/program-log-slice.js";
import { traceparentOf } from "../src/context/trace-context.js";
import type { SecretSet } from "../src/secrets/types.js";
import * as before from "./helpers/program-log-slice-before.js";

// Responsibility: the program log's slices and late files stay what they
// were when its reader moved onto the reader the program's events share
// (src/context/trace-slice.ts). The same log, written in the same pieces
// while the same steps end, goes through the reader as it was
// (tests/helpers/program-log-slice-before.ts) and through the shared one,
// and every result and every file they write is the same, byte for byte.

const PREFIX = "4bf92f35";
const SPAN = "00f067aa0ba902b7";
const STEPS = [`${PREFIX}77b34da6a3ce929d0e0e4736`, `${PREFIX}0123456789abcdef01234567`, `${PREFIX}aaaaaaaaaaaaaaaaaaaaaaaa`];
const SECRET = "hunter2-secret";
const SECRETS: SecretSet = [
  { name: "API_KEY", value: SECRET },
  { name: "WORLD_TRACE_IDS", value: PREFIX, keep: "trace-ids" },
];
const head = gs.sampledFrom(["GET /", "Completed 200 ", "é漢 ", "", `key=${SECRET} `, "\r"]);
const tail = gs.sampledFrom(["", " ms=3", " 🙂", ` ${SECRET}`, "\r"]);

function render(owner: number, start: string, end: string): string {
  if (owner === -1) return `${start}untagged${end}`;
  if (owner === -2) return `${start}${traceparentOf("a1b2c3d477b34da6a3ce929d0e0e4736", SPAN)}${end}`;
  return `${start}[${traceparentOf(STEPS[owner]!, SPAN)}]${end}`;
}

function fileOrNull(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

describe("the program log on the shared reader", () => {
  it("writes the same slices, late files, and counts as the reader it replaced, for any log and wherever each step ended", () =>
    hegel.testAsync(
      async (tc) => {
        const root = mkdtempSync(path.join(os.tmpdir(), "nukadoko-oracle-"));
        try {
          const groups = STEPS.map((_, step) =>
            tc
              .draw(gs.arrays(gs.tuples(gs.integers({ minValue: -2, maxValue: step }), head, tail), { maxSize: 4 }))
              .map(([owner, start, end]) => render(owner, start, end)),
          );
          const early = tc.draw(gs.arrays(gs.tuples(gs.integers({ minValue: -2, maxValue: 0 }), head, tail), { maxSize: 2 })).map(([owner, start, end]) => render(owner, start, end));
          const bytes = Buffer.from(groups.flat().map((line) => `${line}\n`).join(""));
          const ends = [...tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: bytes.length }), { minSize: STEPS.length, maxSize: STEPS.length }))].sort((a, b) => a - b);
          const cuts = [...new Set([...tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: bytes.length }), { maxSize: 4 })), ...ends, bytes.length])].sort((a, b) => a - b);
          const runs = await Promise.all(
            (["before", "shared"] as const).map(async (which) => {
              const dir = path.join(root, which);
              const log = path.join(dir, "program.log");
              mkdirSync(dir);
              writeFileSync(log, early.map((line) => `${line}\n`).join(""));
              const reader = which === "before" ? before.createProgramLogReader(log, PREFIX, SECRETS) : createProgramLogReader(log, PREFIX, SECRETS);
              const slices: unknown[] = [];
              let at = 0;
              let step = 0;
              for (const cut of cuts) {
                appendFileSync(log, bytes.subarray(at, cut));
                at = cut;
                while (step < STEPS.length && ends[step] === cut) {
                  slices.push(await reader.slice(path.join(dir, `step-${step}`), { traceId: STEPS[step]!, stamped: step, lastStampAt: undefined }));
                  step += 1;
                }
              }
              const traced = STEPS.map((traceId, index) => ({ traceId, lines: (slices[index] as { lines: number }).lines, dir: path.join(dir, `step-${index}`) }));
              const late = which === "before" ? before.collectLateLines(log, PREFIX, traced, SECRETS) : collectLateLines(log, PREFIX, traced, SECRETS);
              const files = STEPS.map((_, index) => [
                fileOrNull(path.join(dir, `step-${index}`, PROGRAM_LOG_SLICE_FILE_NAME)),
                fileOrNull(path.join(dir, `step-${index}`, PROGRAM_LOG_LATE_FILE_NAME)),
              ]);
              return { slices, tagged: late.tagged, late: [...late.late.entries()], files };
            }),
          );
          expect(runs[1]).toEqual(runs[0]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      { testCases: 60 },
    ));
});
