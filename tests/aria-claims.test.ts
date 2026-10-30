import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import type { ClaimComparisonRecord } from "../src/record/types.js";
import { claimLine } from "../src/report/summary/claim-line.js";
import { ariaSnapshotReader, takeAriaSnapshots } from "../src/run/aria-reads.js";
import { claimReads, evaluateClaims, judgingBudget, readerNow, unobservedClaims, type AriaSnapshotRead, type ClaimInputs } from "../src/step/evaluate-claims.js";
import { claimsProblem, type Claim, type ClaimStepShape } from "../src/step/claims.js";

// Responsibility: the fits-aria-snapshot compare as a claim (docs/spec.md
// "Claims"): what defineStep refuses, how the run takes the ARIA snapshot
// of the value observe returned (src/run/aria-reads.ts) without running
// any other code of that value's own, how a claim is judged and named on
// the snapshot, and the line a broken one prints. The matcher itself is
// tested in aria-snapshot.test.ts; a real page is in aria-claims-run.test.ts.

const PAGE = ['- heading "Room 7" [level=1]', '- form "Scores":', '  - button "Score"', '  - button "Skip" [disabled]'].join("\n");

/** A stand-in for a locator: its `ariaSnapshot` is a method on its class,
 * as the browser library's is, and it counts the calls. */
class StandIn {
  calls = 0;
  readonly answer: () => unknown;
  constructor(answer: () => unknown) {
    this.answer = answer;
  }
  ariaSnapshot(): unknown {
    this.calls += 1;
    return this.answer();
  }
}

function shape(overrides: Partial<ClaimStepShape> = {}): ClaimStepShape {
  return {
    patterns: ["the page shows"],
    argsKeys: new Set(["tree", "earlier"]),
    requiredArgsKeys: new Set(["tree", "earlier"]),
    fromKeys: new Set(["earlier"]),
    captureKeys: new Set(),
    hasObserve: true,
    rewrittenArgs: new Map(),
    stringArgs: new Set(["tree", "earlier"]),
    ...overrides,
  };
}

const ON_PAGE: Claim = { actual: "page", compare: "fits-aria-snapshot", expected: "tree" };

describe("defineStep and fits-aria-snapshot", () => {
  it("takes a claim on a key observe returns, compared with a sentence key", () => {
    expect(claimsProblem([ON_PAGE], shape())).toBeNull();
    expect(claimsProblem([{ ...ON_PAGE, actual: "room.form" }], shape())).toBeNull();
  });

  it("refuses a claim whose actual is a value an earlier step returned, or an item of each", () => {
    expect(claimsProblem([{ ...ON_PAGE, actual: "earlier" }], shape())).toBe(
      "claims[0].actual reads a value an earlier step returned, which is plain JSON and never a locator or a page, and fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns, so the claim always breaks. Return the locator or page from observe, and name its key in actual",
    );
    expect(claimsProblem([{ actual: "rows", each: { claims: [{ compare: "fits-aria-snapshot", expected: "tree" }] } }], shape())).toBe(
      "claims[0].each.claims[0] compares with fits-aria-snapshot, and an item of each is plain JSON, never a locator or a page, while fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns, so the claim always breaks. Claim the snapshot at the top level, with actual naming the key observe returns it under",
    );
  });

  it("refuses a view, an at, and a count between the value and the snapshot", () => {
    for (const [key, value] of [["view", "text"], ["at", "form"]] as const) {
      expect(claimsProblem([{ ...ON_PAGE, [key]: value }], shape())).toBe(
        `claims[0] has ${key}, and fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns at actual, with nothing between the value and the snapshot. Name the locator or page in actual, and drop ${key}`,
      );
    }
    // A count reads no tree at all, and the count rule says so first.
    expect(claimsProblem([{ ...ON_PAGE, count: true }], shape())).toContain("and fits-aria-snapshot does not compare two numbers");
  });

  it("refuses an expected tree that a program wrote, the pattern's words, or a view of the line's text", () => {
    const wrote = "and the expected ARIA snapshot of fits-aria-snapshot is the tree the line states: a tree a program wrote could be the actual tree copied, so the claim would hold whatever the page shows. Take the expected snapshot from the docstring";
    expect(claimsProblem([{ ...ON_PAGE, expected: { from: "earlier" } }], shape())).toBe(`claims[0].expected reads {"from":"earlier"}, a value a step returned, ${wrote}`);
    expect(claimsProblem([{ ...ON_PAGE, expected: { observe: "printed" } }], shape())).toBe(`claims[0].expected reads {"observe":"printed"}, a value observe read, ${wrote}`);
    expect(claimsProblem([{ ...ON_PAGE, expected: { literal: "shows" } }], shape())).toBe(
      'claims[0].expected is the literal "shows", and the expected ARIA snapshot of fits-aria-snapshot is a tree of lines the line states, which the pattern\'s fixed words are not. Take the expected snapshot from the docstring',
    );
    expect(claimsProblem([{ ...ON_PAGE, expected_view: "text" }], shape())).toBe(
      'claims[0].expected_view is "text", and fits-aria-snapshot reads the expected ARIA snapshot from the text the line states, as it is. Drop expected_view',
    );
  });

  it("refuses an expected key that is not a plain string, which a table or another schema would fill", () => {
    expect(claimsProblem([ON_PAGE], shape({ stringArgs: new Set(["earlier"]) }))).toBe(
      "claims[0].expected is args.tree, which is not a plain z.string(), and fits-aria-snapshot reads the expected ARIA snapshot from the text the line states, so a table or a schema of another type would never reach it as that text. Declare args.tree as z.string(), and fill it with the docstring",
    );
  });

  it("reads the snapshot's path apart from the plain values observe returned", () => {
    const reads = claimReads([ON_PAGE, { actual: "count", compare: "equal", expected: "tree" }], new Set());
    expect(reads.ariaSnapshots).toEqual([["page"]]);
    expect(reads.observed).toEqual([["count"]]);
  });
});

describe("taking the ARIA snapshot of what observe returned", () => {
  it("calls the value's own ariaSnapshot once, wherever the path leads, and keeps what it printed", () =>
    hegel.testAsync(async (tc) => {
      const path = tc.draw(gs.arrays(gs.sampledFrom(["page", "form", "0", "room"]), { minSize: 1, maxSize: 4 }));
      const text = tc.draw(gs.text({ maxSize: 40 }));
      const standIn = new StandIn(() => Promise.resolve(text));
      let root: unknown = standIn;
      for (const segment of [...path].reverse()) root = segment === "0" ? [root] : { [segment]: root };
      const taken = await takeAriaSnapshots(root, [path]);
      expect(ariaSnapshotReader(taken)(path)).toEqual({ text });
      expect(standIn.calls).toBe(1);
      expect(ariaSnapshotReader(taken)([...path, "more"])).toEqual({ unjudged: "has no ARIA snapshot nukadoko took, so the claim was not judged" });
    }));

  it("breaks on a value that is no locator or page, a plain object with the method included, and runs none of its code to find out", async () => {
    let ran = 0;
    const getter = new (class Lookalike {
      get ariaSnapshot() {
        ran += 1;
        return () => PAGE;
      }
    })();
    const own = new StandIn(() => PAGE);
    Object.defineProperty(own, "ariaSnapshot", { value: () => "- heading \"Written in code\"" });
    const reads = await takeAriaSnapshots({ text: PAGE, nothing: null, getter, plain: { ariaSnapshot: () => PAGE }, own }, [["text"], ["nothing"], ["getter"], ["plain"], ["own"], ["absent"]]);
    const read = ariaSnapshotReader(reads);
    const takes = "fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns: return the locator or page itself, and nukadoko takes its snapshot";
    expect(read(["text"])).toEqual({ broken: `is a string, and ${takes}` });
    expect(read(["nothing"])).toEqual({ broken: `is null, and ${takes}` });
    expect(read(["getter"])).toEqual({ broken: `is a Lookalike, and ${takes}` });
    expect(read(["plain"])).toEqual({ broken: `is an Object, and ${takes}` });
    // The method of the value's class, never one set on the value itself.
    expect(read(["own"])).toEqual({ text: PAGE });
    expect(read(["absent"])).toEqual({ broken: "is undefined" });
    expect(ran).toBe(0);
  });

  it("leaves a claim unjudged when the value hides behind a getter or a Proxy, or the browser takes no snapshot", async () => {
    let trapped = 0;
    const proxy = new Proxy(new StandIn(() => PAGE), {
      get(target, key, receiver) {
        trapped += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    let got = 0;
    const behindGetter = Object.defineProperty({}, "page", {
      get() {
        got += 1;
        return new StandIn(() => PAGE);
      },
      enumerable: true,
    });
    const timedOut = new StandIn(() => Promise.reject(new Error("locator.ariaSnapshot: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('form')")));
    const reads = await takeAriaSnapshots({ proxy, behindGetter, timedOut, number: new StandIn(() => 7) }, [["proxy"], ["behindGetter", "page"], ["timedOut"], ["number"]]);
    const read = ariaSnapshotReader(reads);
    expect(read(["proxy"])).toEqual({ unjudged: "is a Proxy, whose ariaSnapshot nukadoko does not call, so the claim was not judged" });
    expect(read(["behindGetter", "page"])).toEqual({ unjudged: "is a getter, which nukadoko does not read, so the claim was not judged" });
    expect(read(["timedOut"])).toEqual({ unjudged: "gave no ARIA snapshot: locator.ariaSnapshot: Timeout 30000ms exceeded, so the claim was not judged" });
    expect(read(["number"])).toEqual({ unjudged: "gave a number from ariaSnapshot() rather than a text, so the claim was not judged" });
    expect([trapped, got, timedOut.calls]).toEqual([0, 0, 1]);
  });
});

function inputs(tree: unknown, snapshot?: AriaSnapshotRead): ClaimInputs {
  return {
    args: readerNow({ tree }),
    observed: readerNow({}),
    ...(snapshot === undefined ? {} : { ariaSnapshots: () => snapshot }),
    schemaChanged: () => null,
    observeReceived: [],
    fromKeys: new Set(),
    argSide: (key) => ({ origin: `sentence:${key}`, segments: [], label: `sentence:${key}` }),
    sentenceText: (key) => (key === "tree" && typeof tree === "string" ? tree : null),
    patterns: ["the page shows"],
    testPattern: async () => ({ reason: "no pattern in these claims" }),
    budget: judgingBudget(Number.POSITIVE_INFINITY, "a test's budget"),
  };
}

async function judged(tree: unknown, snapshot?: AriaSnapshotRead): Promise<ClaimComparisonRecord> {
  const [entry] = await evaluateClaims([ON_PAGE], inputs(tree, snapshot));
  return entry!.record as ClaimComparisonRecord;
}

describe("judging a claim on the snapshot nukadoko took", () => {
  it("holds on a tree that names part of the page, and records the snapshot as the actual value", async () => {
    const tree = '- form "Scores":\n  - button "Score"';
    expect(await judged(tree, { text: PAGE })).toEqual({
      actual: PAGE,
      actual_from: "ARIA snapshot of observe:page",
      compare: "fits-aria-snapshot",
      expected: tree,
      expected_from: "sentence:tree",
      expected_text: tree,
      outcome: "held",
    });
  });

  it("breaks on a tree the page does not hold, and the line names the first expected line that fits nothing and the nearest node", async () => {
    const record = await judged('- form "Scores":\n  - button "Submit"', { text: PAGE });
    expect(record.outcome).toBe("broken");
    expect(record.reason).toBeUndefined();
    expect(claimLine(record)).toMatch(
      /^".*" \(ARIA snapshot of observe:page\) fits-aria-snapshot ".*" \(sentence:tree\) broken; expected line 2 \(button "Submit"\) fits no child of form "Scores" \(actual line 2\); nearest: button "Skip" \[disabled\] \(actual line 4\)$/,
    );
  });

  it("breaks on a tree that names nothing or does not read, and on a value that is no locator, whatever the page shows", async () => {
    expect((await judged('- text: ""', { text: PAGE })).reason).toBe("fits-aria-snapshot has an expected ARIA snapshot that names no node, which every page holds");
    expect((await judged("- heading /Room/", { text: PAGE })).reason).toMatch(/^the expected ARIA snapshot does not read: line 1 names heading with a pattern between slashes/);
    expect((await judged([["- heading"]], { text: PAGE })).reason).toBe("fits-aria-snapshot reads two ARIA snapshots as texts, and compares a string with an array");
    const notLocator = await judged("- heading", { broken: "is a string, and fits-aria-snapshot takes ..." });
    expect([notLocator.outcome, notLocator.reason, notLocator.actual_from]).toEqual(["broken", "observe:page is a string, and fits-aria-snapshot takes ...", "ARIA snapshot of observe:page"]);
    expect(Object.hasOwn(notLocator, "actual")).toBe(false);
  });

  it("leaves the claim unjudged when no snapshot was taken, or the one taken does not read", async () => {
    expect(await judged("- heading", { unjudged: "gave no ARIA snapshot: x, so the claim was not judged" })).toMatchObject({
      outcome: "unjudged",
      reason: "observe:page gave no ARIA snapshot: x, so the claim was not judged",
    });
    expect(await judged("- heading")).toMatchObject({ outcome: "unjudged", reason: "observe:page has no ARIA snapshot nukadoko took, so the claim was not judged" });
    expect((await judged("- heading", { text: "heading" })).reason).toBe(
      'the ARIA snapshot nukadoko took does not read: line 1 is no list item: an ARIA snapshot is a YAML list, and each item starts with "- ", so the claim was not judged',
    );
  });

  it("names the snapshot as the actual side of a claim nothing was compared for", () => {
    const [entry] = unobservedClaims([ON_PAGE], inputs("- heading"));
    expect(entry!.record).toMatchObject({ actual_from: "ARIA snapshot of observe:page", outcome: "unobserved" });
  });
});
