import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import {
  SEVERITIES,
  type FindingText,
  formatFinding,
  formatFindingText,
  oneLine,
  parseFindings,
  whereOf,
} from "../src/finding/finding.js";

const freeText = gs.text({ alphabet: "ab Z:/.-_\t\n\r`'\"{}()", maxSize: 30 });
const pathText = gs.text({ alphabet: "abz/._-", minSize: 1, maxSize: 20 });

const findingText = gs.composite((tc): FindingText => {
  const paths = tc.draw(gs.oneOf(gs.just(undefined), gs.arrays(pathText, { minSize: 1, maxSize: 3 })));
  const fix = tc.draw(gs.oneOf(gs.just(undefined), freeText));
  const next = tc.draw(gs.oneOf(gs.just(undefined), freeText));
  return {
    severity: tc.draw(gs.sampledFrom([...SEVERITIES])),
    code: tc.draw(gs.text({ alphabet: "abz-", minSize: 1, maxSize: 12 })),
    where: tc.draw(freeText),
    message: tc.draw(freeText),
    ...(paths !== undefined ? { paths } : {}),
    ...(fix !== undefined ? { fix } : {}),
    ...(next !== undefined ? { do: next } : {}),
  };
});

/** What the grammar keeps of a finding: every field on one line. */
function asPrinted(finding: FindingText): FindingText {
  return {
    severity: finding.severity,
    code: finding.code,
    where: oneLine(finding.where),
    message: oneLine(finding.message),
    ...(finding.paths !== undefined ? { paths: finding.paths.map(oneLine) } : {}),
    ...(finding.fix !== undefined ? { fix: oneLine(finding.fix) } : {}),
    ...(finding.do !== undefined ? { do: oneLine(finding.do) } : {}),
  };
}

describe("the finding grammar", () => {
  it("reads back every finding it prints, in order, with summary lines between them skipped", () =>
    hegel.test((tc) => {
      const findings = tc.draw(gs.arrays(findingText, { maxSize: 4 }));
      const between = tc.draw(gs.sampledFrom(["", "2 errors, 0 warnings\n", "run\t.nukadoko/runs/x\n"]));
      const text = findings.map(formatFindingText).join(between);

      expect(parseFindings(text)).toEqual(findings.map(asPrinted));
    }));

  it("prints a finding as four tab-separated columns, then fix, then do", () => {
    expect(
      formatFinding({
        severity: "error",
        code: "undefined-step",
        file: "features/greet.feature",
        line: 4,
        message: 'No step definition matches "I run greet"',
        fix: "Reword the line to match a step that exists.",
        do: "nuka scaffold --feature features/greet.feature",
      }),
    ).toBe(
      'error\tundefined-step\tfeatures/greet.feature:4\tNo step definition matches "I run greet"\n' +
        "  fix: Reword the line to match a step that exists.\n" +
        "  do: nuka scaffold --feature features/greet.feature\n",
    );
    expect(formatFinding({ severity: "refused", code: "unknown-argument", message: "Unknown argument: nope" })).toBe(
      "refused\tunknown-argument\t-\tUnknown argument: nope\n",
    );
  });

  it("puts the file and line, the file, the step, or a dash in the location column", () => {
    expect(whereOf({ file: "a.feature", line: 3, step: "s" })).toBe("a.feature:3");
    expect(whereOf({ file: "a.feature", step: "s" })).toBe("a.feature");
    expect(whereOf({ step: "add-todo" })).toBe("add-todo");
    expect(whereOf({})).toBe("-");
  });
});
