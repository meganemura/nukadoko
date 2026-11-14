import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ProcessEntry } from "../src/record/types.js";
import { filesSide, type FilesSource } from "../src/run/changed-files.js";
import { withMeasured } from "../src/run/measured.js";
import { CLAIM_COMPARES, claimsProblem, FILES_COMPARES, type Claim, type ClaimStepShape } from "../src/step/claims.js";
import { defineStep, FILE_CHANGES, isClaimStep, type ChangeKind } from "../src/step/define-step.js";
import { evaluateClaims, judgingBudget, readerNow, type ClaimInputs, type FilesSide } from "../src/step/evaluate-claims.js";

// Responsibility: a claim on the files an earlier step's commands changed
// (docs/spec.md "Files an earlier step changed"), from its declaration to
// its record. defineStep and the claim rules refuse a `files` key, and a
// claim on one, that the run would judge one way on every line or whose
// expected list step code would choose; the list is made from the
// producer's `observed.processes` only where every process was measured
// whole, so an absence a claim reads is one nukadoko saw; and the record
// names the producer's process files as where the list was measured. The
// run that makes the list is tests/files-claims-run.test.ts's.

const producer = defineStep({ pattern: "the build runs", description: "build", args: z.object({}), async run() {} });
const other = defineStep({ pattern: "the check runs", description: "check", args: z.object({}), async run() {} });
const COMPARES_LISTED = FILES_COMPARES.join(", ");

function shapeOf(pattern: string, over: Partial<ClaimStepShape> = {}): ClaimStepShape {
  return {
    patterns: [pattern],
    argsKeys: new Set(),
    requiredArgsKeys: new Set(),
    fromKeys: new Set(),
    captureKeys: new Set(),
    hasObserve: false,
    rewrittenArgs: new Map(),
    stringArgs: new Set(),
    files: new Set(["written"]),
    ...over,
  };
}

const onWritten = (compare: string, expected: unknown, over: Record<string, unknown> = {}): Claim => ({ actual: "written", compare, expected, ...over }) as unknown as Claim;
const PATH = new Set(["path"]);
const CAPTURE = { argsKeys: PATH, requiredArgsKeys: PATH, captureKeys: PATH, stringArgs: PATH };
const LINES = new Set(["docstring"]);
const DOCSTRING = { argsKeys: LINES, requiredArgsKeys: LINES, stringArgs: LINES };
const READS = 'claims[0] reads files.written, the list of paths an earlier step\'s commands changed';

describe("defineStep's files", () => {
  const claimStep = (files: unknown) => () =>
    defineStep({ pattern: "the build writes nothing", args: z.object({}), files, claims: [{ actual: "written", compare: "equal", expected: { literal: [] } }] } as never);

  it("keeps the producer, the changes, and the directory, and gives a claim step with none an empty object", () => {
    const step = claimStep({ written: { of: [producer, other], change: ["added", "changed"], under: "src" } })();
    expect(isClaimStep(step) && step.files).toEqual({ written: { of: [producer, other], change: ["added", "changed"], under: "src" } });
    const none = defineStep({ pattern: "the value is {want:int}", args: z.object({ want: z.number() }), from: { value: [producer, "value"] }, claims: [{ actual: "value", compare: "equal", expected: "want" }] } as never);
    expect(isClaimStep(none) && none.files).toEqual({});
  });

  it("refuses files on a step that acts", () => {
    expect(() => defineStep({ pattern: "a thing", description: "d", args: z.object({}), files: { written: { of: producer } }, async run() {} } as never)).toThrow(
      "defineStep files belongs to a claim step, and this definition has no claims. A step that acts uses run; a step that judges declares claims.",
    );
  });

  it("refuses a key a claim cannot name, an entry that is not { of }, an of that is no step, and a change it does not know", () => {
    expect(claimStep([])).toThrow("defineStep files must be an object whose keys name lists of paths, each { of, change?, under? }.");
    expect(claimStep({ "written.all": { of: producer } })).toThrow('defineStep files key "written.all" is not one key a claim\'s actual can name; name it with one word and no dot.');
    expect(claimStep({ written: producer })).toThrow("defineStep files.written must be an object with of, the step whose commands changed the files.");
    expect(claimStep({ written: { of: producer, kind: "added" } })).toThrow('defineStep files.written has the key "kind", which a files entry does not have. It has of, change, under.');
    for (const of of [undefined, [], "build", [producer, {}]]) {
      expect(claimStep({ written: { of } })).toThrow(
        "defineStep files.written.of must be a step defineStep returned, or a non-empty list of them; import the step whose commands changed the files.",
      );
    }
    expect(claimStep({ written: { of: [producer, producer] } })).toThrow("defineStep files.written.of names one step twice.");
    for (const change of ["written", [], ["added", "moved"]]) {
      expect(claimStep({ written: { of: producer, change } })).toThrow(
        "defineStep files.written.change must be one of added, changed, removed, or a non-empty list of them; leave it out for every change.",
      );
    }
    expect(claimStep({ written: { of: producer, change: ["added", "added"] } })).toThrow("defineStep files.written.change names one change twice.");
  });

  it("refuses a directory no recorded path can be under", () => {
    for (const under of ["/src", "./src", "src/../lib", "src\\gen", "", "src//gen"]) {
      expect(claimStep({ written: { of: producer, under } })).toThrow(
        `defineStep files.written.under is ${JSON.stringify(under)}, and a record lists each path relative to the command's working directory, with / between its parts, so no path is under it. Name the directory that way, such as "src/".`,
      );
    }
    expect(claimStep({ written: { of: producer, under: 3 } })).toThrow('defineStep files.written.under must be a directory relative to the command\'s working directory, such as "src/"; got number.');
    for (const [under, name] of [["node_modules/x", "node_modules"], ["packages/a/.git", ".git"]] as const) {
      expect(claimStep({ written: { of: producer, under } })).toThrow(
        `defineStep files.written.under is ${JSON.stringify(under)}, inside a ${name} directory, which runCommand does not walk, so the list is empty whatever the command did.`,
      );
    }
    expect(claimStep({ written: { of: producer, under: "src/" } })).not.toThrow();
  });
});

describe("a claim that reads files", () => {
  it("takes the compares of a list of paths, and refuses every other compare by name", () =>
    hegel.test((tc) => {
      const compare = tc.draw(gs.sampledFrom(CLAIM_COMPARES));
      // A sentence key of the kind each compare takes, so the compare is
      // the one thing that can be refused.
      const problem =
        compare === "has-item"
          ? claimsProblem([onWritten(compare, "path")], shapeOf("the build wrote {path:string}", CAPTURE))
          : claimsProblem([onWritten(compare, "docstring", { expected_view: "lines" })], shapeOf("the build wrote these files:", DOCSTRING));
      if ((FILES_COMPARES as readonly string[]).includes(compare)) expect(problem).toBeNull();
      else
        expect(problem).toBe(
          `${READS}, which is an array of paths, and "${compare}" does not compare it, so the claim would break on every line or hold on every line. Compare it with ${COMPARES_LISTED}, or count it`,
        );
    }));

  it("refuses an each, a view, an at, and a path inside the list, since nukadoko reads the whole list", () => {
    expect(claimsProblem([{ actual: "written", each: { claims: [{ actual: "x", compare: "equal", expected: { literal: 0 } }] } } as unknown as Claim], shapeOf("nothing was written"))).toBe(
      `${READS}, and a claim on it compares the whole list or counts it. Compare it with ${COMPARES_LISTED}, or count it`,
    );
    for (const [key, value] of [["view", "json"], ["at", "0"]] as const) {
      expect(claimsProblem([onWritten("equal", { literal: [] }, { [key]: value })], shapeOf("nothing was written"))).toBe(
        `claims[0] has the key "${key}", which a claim on files does not have. It has actual, count, compare, expected, expected_view`,
      );
    }
    expect(claimsProblem([{ actual: "written.0", compare: "equal", expected: { literal: "a" } }], shapeOf("nothing was written to a"))).toBe(
      'claims[0].actual reads inside files.written, a list of paths with nothing to walk into. Name the key alone: actual "written"',
    );
  });

  it("refuses an expected list that step code returned or read, since step code would then choose what the measurement is compared with", () => {
    const fromKeys = new Set(["paths"]);
    expect(claimsProblem([onWritten("equal", { from: "paths" })], shapeOf("the build wrote what it said", { fromKeys }))).toBe(
      `${READS}, and its expected value is { from }, a value step code returned, so step code would choose the list the measured one is compared with. State the expected paths in the sentence: a capture, the docstring, or the pattern's words`,
    );
    expect(claimsProblem([onWritten("equal", { observe: "paths" })], shapeOf("the build wrote what is there", { hasObserve: true }))).toBe(
      `${READS}, and its expected value is { observe }, a value step code read, so step code would choose the list the measured one is compared with. State the expected paths in the sentence: a capture, the docstring, or the pattern's words`,
    );
  });

  it("refuses an expected value of the wrong kind: has-item takes one path, and the other compares take a list", () => {
    expect(claimsProblem([onWritten("has-item", { literal: 2 })], shapeOf("the build wrote 2"))).toBe(
      `${READS}, and its expected value is the literal 2, which is never a text, so has-item judges it the same way on every line. State the path in the pattern's fixed words, or capture it`,
    );
    expect(claimsProblem([onWritten("equal", { literal: "a.ts" })], shapeOf("the build wrote a.ts"))).toBe(
      `${READS}, and its expected value is the literal "a.ts", which is never an array, so equal judges it the same way on every line. State the list with a word such as nothing or no, or read the docstring with expected_view lines`,
    );
    expect(claimsProblem([onWritten("has-same-items", "docstring")], shapeOf("the build wrote exactly these files:", DOCSTRING))).toBe(
      `${READS}, and its expected value is args.docstring, a plain z.string(), which is never an array, so has-same-items judges it the same way on every line. State the list with a word such as nothing or no, or read the docstring with expected_view lines`,
    );
    expect(claimsProblem([onWritten("has-same-items", "docstring", { expected_view: "lines" })], shapeOf("the build wrote exactly these files:", DOCSTRING))).toBeNull();
  });

  it("counts the list against a number the sentence states", () => {
    expect(claimsProblem([onWritten("equal", { literal: 2 }, { count: true })], shapeOf("the build wrote 2 files"))).toBeNull();
  });

  it("refuses a files key that has the name of another source, and one no claim reads", () => {
    expect(claimsProblem([onWritten("equal", { literal: [] })], shapeOf("nothing was written", { fromKeys: new Set(["written"]) }))).toBe(
      'files.written has the name of a key of from, so a claim\'s actual "written" would have two sources. Rename one of them',
    );
    expect(claimsProblem([onWritten("equal", { literal: [] })], shapeOf("nothing was written", { files: new Set(["written", "source"]) }))).toBe(
      'files.source is read by no claim, so the list it names changes no verdict. Compare a claim with actual "source", or take the key out of files',
    );
  });
});

const CWD = "/work/app";
const measuredProcess = (files: ProcessEntry["files"], over: Partial<ProcessEntry> = {}): ProcessEntry => ({ command: ["build"], cwd: CWD, exit_code: 0, duration_ms: 1, group: "ended", files, ...over });
const sourceOf = (processes: readonly ProcessEntry[] | null): FilesSource => ({ of: "the-build@4", record: { step_record_id: "step-1", processes } });
const LABEL = "files:the-build@4 added, changed, or removed";

describe("the list a files key reads", () => {
  it("is unjudged, with the reason, wherever a path the commands changed may be missing from it", () => {
    const entry = { of: producer };
    expect(filesSide(entry, { of: "files.written.of", unchosen: "no earlier line ran it" })).toEqual({ label: "files:files.written.of added, changed, or removed", unjudged: "no earlier line ran it" });
    for (const processes of [null, []]) {
      expect(filesSide(entry, sourceOf(processes))).toEqual({
        label: LABEL,
        unjudged: "the-build@4 ran no runCommand process, so nukadoko measured no file for it, and a list it never measured is not an empty list",
      });
    }
    expect(filesSide(entry, sourceOf([measuredProcess({ added: [], changed: [], removed: [] }), measuredProcess(undefined)]))).toEqual({
      label: LABEL,
      unjudged: "the record of process 2 of the-build@4 lists no files, so what it changed was not measured",
    });
    expect(filesSide(entry, sourceOf([measuredProcess({ unmeasured: "more than 20000 entries under the working directory" })]))).toEqual({
      label: LABEL,
      unjudged: "nukadoko did not measure the files process 1 of the-build@4 changed: more than 20000 entries under the working directory",
    });
    expect(filesSide(entry, sourceOf([measuredProcess({ added: [], changed: [], removed: [] }, { group: "running" })]))).toEqual({
      label: LABEL,
      unjudged: "process 1 of the-build@4 left a process of its group running when it closed, so a file that process wrote after the walk is not in the list",
    });
    expect(filesSide(entry, sourceOf([measuredProcess({ added: ["a"], changed: [], removed: [] }), measuredProcess({ added: [], changed: [], removed: [] }, { cwd: "/work/app/sub" })]))).toEqual({
      label: LABEL,
      unjudged: "the commands of the-build@4 ran in 2 working directories, /work/app and /work/app/sub, and each lists its paths relative to its own, so they make no one list",
    });
    expect(filesSide({ of: producer, under: "packages/a/node_modules/x" }, sourceOf([measuredProcess({ added: [], changed: [], removed: [], skipped: ["packages/a/node_modules/"] })]))).toEqual({
      label: `${LABEL} under packages/a/node_modules/x/`,
      unjudged: "packages/a/node_modules/x/ is inside packages/a/node_modules/, which process 1 of the-build@4 did not walk, so the list is empty whatever it did",
    });
  });

  const names = gs.sampledFrom(["src/", "src/a.ts", "src/gen/", "src/gen/b.ts", "srcx.ts", "migrations/", "migrations/0002_add_note.sql", "README.md"]);
  const processFiles = gs.composite((tc) => ({
    added: tc.draw(gs.arrays(names, { maxSize: 4 })),
    changed: tc.draw(gs.arrays(names, { maxSize: 4 })),
    removed: tc.draw(gs.arrays(names, { maxSize: 4 })),
  }));
  const changeLists = gs.sampledFrom<readonly ChangeKind[]>([["added"], ["changed"], ["removed"], ["added", "changed"], ["changed", "removed"], FILE_CHANGES]);

  it("is every path the selected changes of every process name, under the directory, sorted and once each", () =>
    hegel.test((tc) => {
      const files = tc.draw(gs.arrays(processFiles, { minSize: 1, maxSize: 3 }));
      const change = tc.draw(changeLists);
      const under = tc.draw(gs.sampledFrom([undefined, "src", "src/", "src/gen", "migrations"]));
      const side = filesSide({ of: producer, change: change as never, ...(under === undefined ? {} : { under }) }, sourceOf(files.map((each) => measuredProcess(each))));
      if (!("paths" in side)) throw new Error(`expected a list, got ${side.unjudged}`);
      const dir = under === undefined ? "" : under.endsWith("/") ? under : `${under}/`;
      const named = files.flatMap((each) => change.flatMap((kind) => each[kind])).filter((path) => path.startsWith(dir) && path !== dir);
      expect(side.paths).toEqual([...new Set(named)].sort());
      expect(side.measured).toEqual({ step_record_id: "step-1", channel: files.length === 1 ? "observed.processes[0].files" : "observed.processes" });
      // A narrower selection never names a path the whole list does not.
      const whole = filesSide({ of: producer }, sourceOf(files.map((each) => measuredProcess(each))));
      if (!("paths" in whole)) throw new Error("expected a list");
      for (const path of side.paths) expect(whole.paths).toContain(path);
    }));
});

function inputsWith(side: FilesSide, pattern: string, args: Record<string, unknown> = {}): ClaimInputs {
  return {
    args: readerNow(args),
    observed: readerNow(undefined),
    schemaChanged: () => null,
    observeReceived: [],
    fromKeys: new Set(),
    argSide: (key) => ({ origin: `sentence:${key}`, segments: [], label: `sentence:${key}` }),
    sentenceText: (key) => (key in args ? String(args[key]) : null),
    patterns: [pattern],
    testPattern: async () => ({ reason: "no claim here tests a pattern" }),
    budget: judgingBudget(Number.POSITIVE_INFINITY, "a test's budget"),
    files: new Map([["written", side]]),
  };
}

const MEASURED = { step_record_id: "step-1", channel: "observed.processes[0].files" };
const listSide = (paths: readonly string[]): FilesSide => ({ label: LABEL, paths, measured: MEASURED });
const recordsOf = async (claims: readonly Claim[], inputs: ClaimInputs) =>
  withMeasured(await evaluateClaims(claims, inputs), { ownRecordId: "step-2", ownChannels: [], fromRecordOf: () => null, channelsOf: () => [], secrets: [] });

describe("judging a list of paths", () => {
  it("holds on an empty list and breaks on a path, naming the producer's process files as where the list was measured", async () => {
    const [held] = await recordsOf([onWritten("equal", { literal: [] })], inputsWith(listSide([]), "the build writes nothing"));
    expect(held).toEqual({
      actual: [],
      actual_from: LABEL,
      compare: "equal",
      expected: [],
      expected_from: "literal:nothing",
      expected_text: "nothing",
      outcome: "held",
      measured: MEASURED,
    });
    const [broken] = await recordsOf([onWritten("equal", { literal: [] })], inputsWith(listSide(["src/a.ts"]), "the build writes nothing"));
    expect(broken).toMatchObject({ actual: ["src/a.ts"], outcome: "broken", measured: MEASURED });
  });

  it("compares with the path the sentence captures and the docstring's lines", async () => {
    const [item] = await recordsOf([onWritten("has-item", "path")], inputsWith(listSide(["migrations/", "migrations/0002_add_note.sql"]), "the build wrote {path:string}", { path: "migrations/0002_add_note.sql" }));
    expect(item).toMatchObject({ expected: "migrations/0002_add_note.sql", expected_from: "sentence:path", outcome: "held" });
    const [same] = await recordsOf(
      [onWritten("has-same-items", "docstring", { expected_view: "lines" })],
      inputsWith(listSide(["b.ts", "a.ts"]), "the build wrote exactly these files:", { docstring: "a.ts\nb.ts" }),
    );
    expect(same).toMatchObject({ expected: ["a.ts", "b.ts"], expected_from: "sentence:docstring as lines", outcome: "held" });
  });

  it("records no list, and no channel, where the producer measured none", async () => {
    const [unjudged] = await recordsOf([onWritten("equal", { literal: [] })], inputsWith({ label: LABEL, unjudged: "the-build@4 ran no runCommand process" }, "the build writes nothing"));
    expect(unjudged).toEqual({
      actual_from: LABEL,
      compare: "equal",
      expected: [],
      expected_from: "literal:nothing",
      expected_text: "nothing",
      outcome: "unjudged",
      reason: "the-build@4 ran no runCommand process",
      measured: null,
    });
  });
});
