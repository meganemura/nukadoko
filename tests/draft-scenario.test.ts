import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Vocabulary } from "../src/discover/discover-steps.js";
import { readBack, type LineEntry } from "../src/draft/index.js";
import { buildStepBindings } from "../src/run/match-step.js";
import { defineStep } from "../src/step/define-step.js";

// Responsibility: a table or docstring the shared draft renderer writes
// reads back, through nuka run's parser and binder, to the value it was
// written from.

const noteStep = defineStep({
  pattern: "a note is written",
  description: "d",
  args: z.object({ body: z.string() }),
  returns: z.object({}),
  run: () => ({}),
});
const rowsStep = defineStep({
  pattern: "rows are written",
  description: "d",
  args: z.object({ rows: z.array(z.array(z.string())) }),
  returns: z.object({}),
  run: () => ({}),
});
const vocabulary: Vocabulary = new Map([
  ["write-note", { kind: "typed", name: "write-note", step: noteStep } as never],
  ["write-rows", { kind: "typed", name: "write-rows", step: rowsStep } as never],
]);
const bindings = buildStepBindings(vocabulary);

async function failureFor(entry: LineEntry): Promise<string | undefined> {
  await readBack([entry], vocabulary, bindings, "<test>");
  return entry.roundTripFailure;
}

const ALPHABET = 'ab "\\|#';

describe("draft read-back", () => {
  it("reads a docstring back to the text it was written from", () =>
    hegel.testAsync(async (tc) => {
      const lines = tc.draw(gs.arrays(gs.text({ minSize: 1, maxSize: 6, alphabet: ALPHABET }), { minSize: 1, maxSize: 4 }));
      const body = lines.map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
      if (body.length === 0) return;
      const entry: LineEntry = {
        kind: "line",
        stepName: "write-note",
        text: "a note is written",
        attachment: { kind: "docstring", key: "body", value: body },
        expectedInlineArgs: { body },
        comments: [],
      };
      expect(await failureFor(entry)).toBe(undefined);
    }));

  it("reads a table back to the rows it was written from", () =>
    hegel.testAsync(async (tc) => {
      const width = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
      const rows = tc.draw(
        gs.arrays(gs.arrays(gs.text({ minSize: 1, maxSize: 5, alphabet: ALPHABET }), { minSize: width, maxSize: width }), {
          minSize: 1,
          maxSize: 3,
        }),
      );
      const trimmed = rows.map((row) => row.map((cell) => cell.trim()));
      const entry: LineEntry = {
        kind: "line",
        stepName: "write-rows",
        text: "rows are written",
        attachment: { kind: "table", key: "rows", value: trimmed },
        expectedInlineArgs: { rows: trimmed },
        comments: [],
      };
      expect(await failureFor(entry)).toBe(undefined);
    }));
});
