import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { exitedProducers, firstErrorLine, formatRerunCommand, formatStepFailure } from "../src/run/progress-log.js";

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
      const line = tc.draw(visibleLine.filter((drawn) => !drawn.trim().endsWith(":")));
      const rest = tc.draw(gs.text({ maxSize: 40 }));
      const newline = tc.draw(gs.sampledFrom(["\n", "\r\n", "\r"]));
      const message = [...leading, line].join(newline) + newline + rest;
      expect(firstErrorLine(message)).toBe(line.trim());
    }));

  it("joins a first line that ends in a colon to the next visible line, and to nothing after it", () =>
    hegel.test((tc) => {
      const introduction = `${tc.draw(visibleLine)}:`;
      const blanks = tc.draw(gs.arrays(blankLine, { maxSize: 3 }));
      const next = tc.draw(visibleLine);
      const rest = tc.draw(gs.text({ maxSize: 40 }));
      const newline = tc.draw(gs.sampledFrom(["\n", "\r\n", "\r"]));
      const message = [introduction, ...blanks, next].join(newline) + newline + rest;
      expect(firstErrorLine(message)).toBe(`${introduction.trim()} ${next.trim()}`);
    }));

  it("keeps a colon-ended line as it is when nothing visible follows it", () => {
    expect(firstErrorLine("init exited 1:\n  \n")).toBe("init exited 1:");
  });

  it("names a crashed program after the colon by its error, not by Node's header", () => {
    const message = [
      "init exited 1:",
      "/tmp/project/node_modules/tool/cli.js:3",
      "import { run } from '../dist/cli.js';",
      "^^^^^^",
      "",
      "Error: Cannot find module '../dist/cli.js'",
      "    at load (node:internal/modules/cjs/loader:1)",
    ].join("\n");
    expect(firstErrorLine(message)).toBe("init exited 1: Error: Cannot find module '../dist/cli.js'");
  });

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

// The header Node writes before an uncaught error: where it was thrown,
// that source line, and carets under it.
const nodeLocation = gs.oneOf(
  gs.sampledFrom(["node:internal/modules/cjs/loader", "node:internal/modules/esm/resolve"]),
  gs.text({ minSize: 1, maxSize: 20, alphabet: "abc/._- " }).map((rest) => `/${rest}.js`),
  gs.text({ minSize: 1, maxSize: 20, alphabet: "abc/._-" }).map((rest) => `file:///${rest}.mjs`),
  gs.text({ minSize: 1, maxSize: 20, alphabet: "abc\\._- " }).map((rest) => `C:\\${rest}.js`),
);
const nodeHeader = gs.tuples(
  nodeLocation,
  gs.integers({ minValue: 1, maxValue: 99999 }),
  gs.text({ maxSize: 30, alphabet: "abc(){};= \"'^:" }),
  gs.integers({ minValue: 0, maxValue: 8 }),
  gs.integers({ minValue: 1, maxValue: 6 }),
).map(([location, line, source, indent, carets]) => `${location}:${line}\n${source}\n${" ".repeat(indent)}${"^".repeat(carets)}`);
const nodeHeaderEnd = gs.sampledFrom(["\n\n", "\n"]);
const messageWithText = gs.text({ maxSize: 60 }).filter((text) => firstErrorLine(text) !== "(no message)");

describe("firstErrorLine: a Node uncaught-error header", () => {
  it("reads past the header to the line after it", () =>
    hegel.test((tc) => {
      const message = tc.draw(messageWithText);
      const header = tc.draw(nodeHeader);
      expect(firstErrorLine(header + tc.draw(nodeHeaderEnd) + message)).toBe(firstErrorLine(message));
    }));

  it("keeps a prefix that comes before the header's location", () =>
    hegel.test((tc) => {
      const prefix = tc.draw(gs.text({ minSize: 1, maxSize: 20, alphabet: "abc123" }));
      const message = tc.draw(messageWithText);
      const header = tc.draw(nodeHeader);
      expect(firstErrorLine(`${prefix}: ${header}${tc.draw(nodeHeaderEnd)}${message}`)).toBe(
        `${prefix}: ${firstErrorLine(message)}`,
      );
    }));

  it("names the error Node printed for a missing module", () => {
    const stderr = [
      "node:internal/modules/cjs/loader:1568",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module '/repo/dist/cli.js'",
      "    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)",
      "",
      "Node.js v24.22.0",
    ].join("\n");
    expect(firstErrorLine(`stow init exited 1: ${stderr}`)).toBe("stow init exited 1: Error: Cannot find module '/repo/dist/cli.js'");
    expect(
      formatStepFailure({ errorMessage: "exit: expected 0, got 1", recordPath: null, used: [{ step: "run-missing", result: { exitCode: 1, stderr } }] }),
    ).toEqual(["exit: expected 0, got 1", "used    run-missing  exit 1  Error: Cannot find module '/repo/dist/cli.js'"]);
  });

  it("keeps a location line that no caret line follows", () => {
    expect(firstErrorLine("/repo/src/a.ts:12\nexpected 1, got 2")).toBe("/repo/src/a.ts:12");
    expect(firstErrorLine("node:internal/x:3\n  throw err;\n")).toBe("node:internal/x:3");
  });
});

describe("formatStepFailure", () => {
  it("names the error line, then the step record when there is one", () => {
    expect(
      formatStepFailure({ errorMessage: "expected 5, got 4\n    at sum.ts:3", recordPath: ".nukadoko/runs/run-1/steps/s-1" }),
    ).toEqual(["expected 5, got 4", "record  .nukadoko/runs/run-1/steps/s-1"]);
    expect(formatStepFailure({ errorMessage: "No step definition matches", recordPath: null })).toEqual([
      "No step definition matches",
    ]);
  });
});

describe("formatStepFailure: a used producer that exited nonzero", () => {
  const record = ".nukadoko/runs/run-1/steps/s-2";
  const failed = (used: { step: string; result?: unknown }[]) =>
    formatStepFailure({ errorMessage: 'expected "Hello, Ada!", got ""', recordPath: record, used });

  it("names the producer, its exit code, and the first visible line of its stderr, before the record", () => {
    expect(
      failed([
        {
          step: "run-greet",
          result: {
            exitCode: 1,
            stdout: "",
            stderr: "\n  Error [ERR_MODULE_NOT_FOUND]: Cannot find module './greet.js'\n    at resolve (node:internal)\n",
          },
        },
      ]),
    ).toEqual([
      'expected "Hello, Ada!", got ""',
      "used    run-greet  exit 1  Error [ERR_MODULE_NOT_FOUND]: Cannot find module './greet.js'",
      `record  ${record}`,
    ]);
  });

  it("reads (no stderr) when the process wrote nothing visible", () => {
    expect(failed([{ step: "run-greet", result: { exitCode: 2, stderr: " \n" } }])).toEqual([
      'expected "Hello, Ada!", got ""',
      "used    run-greet  exit 2  (no stderr)",
      `record  ${record}`,
    ]);
  });

  it("says nothing for exit 0, a signal, a result that is not a process, or no result", () => {
    expect(
      failed([
        { step: "a", result: { exitCode: 0, stderr: "warning" } },
        { step: "b", result: { exitCode: null, stderr: "killed" } },
        { step: "c", result: "exit 1" },
        { step: "d", result: null },
        { step: "e", result: { exitCode: 1 } },
        { step: "f" },
      ]),
    ).toEqual(['expected "Hello, Ada!", got ""', `record  ${record}`]);
  });

  it("writes one line per producer, in used order", () => {
    expect(
      failed([
        { step: "build", result: { exitCode: 2, stderr: "tsc failed" } },
        { step: "run-greet", result: { exitCode: 1, stderr: "no dist" } },
      ]),
    ).toEqual([
      'expected "Hello, Ada!", got ""',
      "used    build  exit 2  tsc failed",
      "used    run-greet  exit 1  no dist",
      `record  ${record}`,
    ]);
  });
});

describe("exitedProducers", () => {
  // Fields drawn from a small pool, so the exact shape a process result has
  // comes up often among results that only nearly have it.
  const field = gs.oneOf<unknown>(
    gs.integers({ minValue: -2, maxValue: 3 }),
    gs.just(null),
    gs.text({ maxSize: 12 }),
    gs.booleans(),
  );
  const result = gs.oneOf<unknown>(
    gs.record({ exitCode: field, stderr: field }),
    gs.record({ exitCode: field }),
    gs.record({ stderr: field }),
    field,
  );

  it("keeps exactly the entries with a nonzero number exitCode and a string stderr, in order", () =>
    hegel.test((tc) => {
      const used = tc.draw(
        gs.arrays(
          gs.record({ step: gs.text({ minSize: 1, maxSize: 8, alphabet: "abc-" }), result }),
          { maxSize: 6 },
        ),
      );
      const expected = used.filter((entry) => {
        const value = entry.result as { exitCode?: unknown; stderr?: unknown } | null;
        return (
          typeof value === "object" &&
          value !== null &&
          typeof value.exitCode === "number" &&
          value.exitCode !== 0 &&
          typeof value.stderr === "string"
        );
      });
      const exited = exitedProducers(used);
      expect(exited.map((producer) => producer.step)).toEqual(expected.map((entry) => entry.step));
      for (const producer of exited) {
        expect(producer.stderrLine.trim().length).toBeGreaterThan(0);
        expect(producer.stderrLine).not.toMatch(/[\r\n\u2028\u2029]/);
      }
    }));
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
