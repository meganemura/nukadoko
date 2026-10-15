import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { firstErrorLine, formatRerunCommand, formatStepFailure } from "../src/run/progress-log.js";

// Responsibility: the pure formatting `nuka run` uses to say why a step
// failed and how to rerun its scenario. The properties are that the error
// line is always one visible line taken from the message, and that the
// rerun line splits back, under POSIX shell quoting, into the exact words
// it was built from.

// Splits a command line the way a POSIX shell does for the only quoting
// formatRerunCommand writes: single quotes, and a backslash outside them.
function shellSplit(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quoted) {
      if (char === "'") quoted = false;
      else current += char;
    } else if (char === "'") {
      quoted = true;
      started = true;
    } else if (char === "\\") {
      index += 1;
      current += command[index] ?? "";
      started = true;
    } else if (char === " ") {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

const visibleLine = gs
  .text({ minSize: 1, maxSize: 30, alphabet: "abcXYZ 0123:;\"'.()" })
  .filter((line) => line.trim().length > 0);
const blankLine = gs.text({ maxSize: 4, alphabet: " \t" });

describe("firstErrorLine", () => {
  it("returns the first visible line, trimmed, whatever follows it", () =>
    hegel.test((tc) => {
      const leading = tc.draw(gs.arrays(blankLine, { maxSize: 3 }));
      const line = tc.draw(visibleLine);
      const rest = tc.draw(gs.text({ maxSize: 40 }));
      const newline = tc.draw(gs.sampledFrom(["\n", "\r\n", "\r"]));
      const message = [...leading, line].join(newline) + newline + rest;
      expect(firstErrorLine(message)).toBe(line.trim());
    }));

  it("ignores terminal color codes", () =>
    hegel.test((tc) => {
      const line = tc.draw(visibleLine);
      const code = tc.draw(gs.sampledFrom(["\u001b[31m", "\u001b[2m", "\u001b[39m", "\u001b[1;31m"]));
      expect(firstErrorLine(`${code}${line}\u001b[0m`)).toBe(firstErrorLine(line));
    }));

  it("is never blank and never more than one line", () =>
    hegel.test((tc) => {
      const result = firstErrorLine(tc.draw(gs.text({ maxSize: 60 })));
      expect(result.trim().length).toBeGreaterThan(0);
      expect(result).not.toMatch(/[\r\n\u2028\u2029]/);
    }));

  it("reads (no message) for a message with no visible text", () => {
    expect(firstErrorLine(" \n\t\n")).toBe("(no message)");
  });
});

describe("formatStepFailure", () => {
  it("names the error line, then the step record when there is one", () => {
    expect(
      formatStepFailure({ errorMessage: "expected 5, got 4\n    at sum.ts:3", recordPath: ".nukadoko/records/steps/s-1" }),
    ).toEqual(["expected 5, got 4", "record  .nukadoko/records/steps/s-1"]);
    expect(formatStepFailure({ errorMessage: "No step definition matches", recordPath: null })).toEqual([
      "No step definition matches",
    ]);
  });
});

// Shell metacharacters drawn often, since a general text generator rarely
// draws a quote or a space at all.
const shellText = (maxSize: number) =>
  gs.oneOf(gs.text({ maxSize }), gs.text({ maxSize, alphabet: "a/.:' \\\"$-" }));

describe("formatRerunCommand", () => {
  it("leaves a plain feature path unquoted", () => {
    expect(formatRerunCommand({ feature: "features/sum.feature", line: 3 }, [])).toBe("nuka run features/sum.feature:3");
    expect(formatRerunCommand({ feature: "features/sum.feature", line: 3 }, ["--env", "staging"])).toBe(
      "nuka run features/sum.feature:3 --env staging",
    );
  });

  it("splits back into the words it was built from, under POSIX shell quoting", () =>
    hegel.test((tc) => {
      const feature = tc.draw(shellText(30));
      const line = tc.draw(gs.integers({ minValue: 1, maxValue: 100000 }));
      const flags = tc.draw(gs.arrays(shellText(12), { maxSize: 3 }));
      expect(shellSplit(formatRerunCommand({ feature, line }, flags))).toEqual([
        "nuka",
        "run",
        `${feature}:${line}`,
        ...flags,
      ]);
    }));
});
