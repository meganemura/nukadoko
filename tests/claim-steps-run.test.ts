import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  ensureNukadokoShim,
  latestRunDir,
  latestRunJson,
  removeTempDir,
} from "./helpers/fixtures.js";

// Responsibility: what a claim step records and refuses, end to end, through
// `nuka check` and `nuka run` on a project written for each case
// (docs/spec.md "Claims"). Each case is a way a step file could make a claim
// pass, or a record say something false, without the behaviour the sentence
// states: a schema that rewrites the expected value, a value that is not
// JSON, a pattern that never returns, a copy of a step with other claims.
// The pure rules have their properties in tests/claims.test.ts; this file
// shows that the runner and the loader apply them.

const CONFIG = 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n';

/** A step that acts and returns a fixed cart, so a claim step has `from`
 * values to read without a process or a server. */
const ANSWER_STEP = `import { defineStep, z } from "nukadoko";
export default defineStep({
  description: "The app answers",
  pattern: "the app answers",
  args: z.object({}),
  returns: z.object({
    cart: z.object({ count: z.number(), items: z.array(z.object({ title: z.string(), paid: z.boolean() })) }),
    out: z.string(),
    body: z.unknown(),
  }),
  mutates: false,
  run() {
    return { cart: { count: 1, items: [{ title: "a", paid: true }, { title: "b", paid: false }] }, out: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", body: { id: 7, tags: ["x"] } };
  },
});
`;

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await removeTempDir(dir);
  dirs = [];
});

async function project(files: Record<string, string>): Promise<string> {
  await ensureNukadokoShim();
  const rootDir = await createEmptyTempDir();
  dirs.push(rootDir);
  const all: Record<string, string> = { "nukadoko.config.ts": CONFIG, "features/steps/the-app-answers.ts": ANSWER_STEP, ...files };
  for (const [relative, text] of Object.entries(all)) {
    const file = path.join(rootDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return rootDir;
}

async function cli(rootDir: string, argv: string[]) {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

/** The claim step of the newest run: the last step of its first scenario. */
function lastClaimStep(rootDir: string): Record<string, any> {
  const run = latestRunJson(rootDir);
  return run.scenarios[0].steps.at(-1) as Record<string, any>;
}

function feature(...lines: string[]): string {
  return ["Feature: claims", "  Scenario: one", ...lines.map((line) => `    ${line}`), ""].join("\n");
}

describe("a schema that rewrites the value a claim reads is refused at defineStep", () => {
  const cases: readonly [string, string][] = [
    ["a transform", "z.number().transform(() => 0)"],
    ["z.coerce", "z.coerce.number()"],
    ["a preprocess", "z.preprocess((value) => value, z.number())"],
    ["an overwrite check (trim, toLowerCase, toUpperCase, normalize, or overwrite)", "z.string().trim()"],
  ];

  it.each(cases)("refuses %s on the expected key, and nuka check names it", async (rewrite, schema) => {
    const rootDir = await project({
      "features/steps/it-counts.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "it counts {code}",
  args: z.object({ code: ${schema}, cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.count", compare: "equal", expected: "code" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then it counts 5"),
    });
    const result = await cli(rootDir, ["check", "features/t.feature"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      `defineStep claims[0].expected reads args.code, and its schema rewrites the value the line states or an earlier step returned (${rewrite}), so step code would decide what the claim compares. Take the rewrite out of the schema, or read the line's text with expected_view (text, lines, or json).`,
    );
  });

  it("refuses a transform on the from key a claim measures", async () => {
    const rootDir = await project({
      "features/steps/it-counts.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "it counts {code:int}",
  args: z.object({ code: z.number(), cart: answer.returns.shape.cart.transform(() => ({ count: 5 })) }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.count", compare: "equal", expected: "code" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then it counts 5"),
    });
    const result = await cli(rootDir, ["check", "features/t.feature"]);
    expect(result.stdout + result.stderr).toContain(
      "defineStep claims[0].actual reads args.cart, and its schema rewrites the value the claim measures (a transform), so step code would decide what the claim compares. Take the rewrite out of the schema.",
    );
  });

  it("reads a docstring as JSON through expected_view, and the record keeps the docstring as the line stated it", async () => {
    const rootDir = await project({
      "features/steps/the-body-is.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the body is",
  args: z.object({ expected: z.string(), body: z.unknown() }),
  from: { body: [answer, "body"] },
  claims: [{ actual: "body", compare: "equal", expected: "expected", expected_view: "json" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the body is", '  """', '  { "tags": ["x"], "id": 7 }', '  """'),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(0);
    expect(lastClaimStep(rootDir).claims).toEqual([
      {
        actual: { id: 7, tags: ["x"] },
        actual_from: "from:the-app-answers@3.body",
        compare: "equal",
        expected: { tags: ["x"], id: 7 },
        expected_from: "sentence:expected as json",
        expected_view: "json",
        expected_text: '{ "tags": ["x"], "id": 7 }',
        outcome: "held",
        measured: null,
      },
    ]);
  });
});

describe("a value that is not plain JSON breaks the claim, and the record says which part", () => {
  it("breaks on a Date observe returned, and records no actual", async () => {
    const rootDir = await project({
      "features/steps/it-is-dated.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "it is dated {date:string}",
  args: z.object({ date: z.string() }),
  observe() { return { when: new Date(0) }; },
  claims: [{ actual: "when", compare: "equal", expected: "date" }],
});
`,
      "features/t.feature": feature('Then it is dated "1970-01-01"'),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const step = lastClaimStep(rootDir);
    expect(step.claims[0]).toEqual({
      actual_from: "observe:when",
      compare: "equal",
      expected: "1970-01-01",
      expected_from: "sentence:date",
      expected_text: '"1970-01-01"',
      outcome: "broken",
      reason: "observe:when is a Date, not a JSON value, so the record could not show what was compared",
      measured: null,
    });
    expect(step.error.kind).toBe("claim_broken");
  });

  it("breaks on a bigint on either side, naming it", async () => {
    const rootDir = await project({
      "features/steps/the-total-is.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the total is at least {n:biginteger}",
  args: z.object({ n: z.bigint() }),
  observe() { return { total: 12345678901234567890n }; },
  claims: [{ actual: "total", compare: "at-least", expected: "n" }],
});
`,
      "features/t.feature": feature("Then the total is at least 5"),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({
      outcome: "broken",
      reason: "observe:total is the bigint 12345678901234567890n, not a JSON value, so the record could not show what was compared",
    });
  });

  it("breaks, and does not crash, on an array item that is undefined", async () => {
    const rootDir = await project({
      "features/steps/the-history-holds.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the history holds the cart",
  args: z.object({ cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  observe() { return { history: [undefined] }; },
  claims: [{ actual: "history", compare: "has-item", expected: { from: "cart" } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the history holds the cart"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const step = lastClaimStep(rootDir);
    expect(step.error.kind).toBe("claim_broken");
    expect(step.claims[0]).toMatchObject({
      outcome: "broken",
      reason: "observe:history.0 is undefined, not a JSON value, so the record could not show what was compared",
    });
  });
});

describe("a path reads own properties only", () => {
  it("finds nothing at a segment that names an Object.prototype member", async () => {
    const rootDir = await project({
      "features/steps/the-cart-kind-is.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart kind is {kind:string}",
  args: z.object({ kind: z.string(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.constructor.name", compare: "equal", expected: "kind" }],
});
`,
      "features/t.feature": feature("When the app answers", 'Then the cart kind is "Object"'),
    });
    await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({
      outcome: "broken",
      reason: "from:the-app-answers@3.cart.constructor.name is undefined",
    });
  });
});

describe("both sides of a claim are compared by where they read", () => {
  it("breaks a claim whose at and from path read one value", async () => {
    const rootDir = await project({
      "features/steps/the-count-is-unchanged.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart count is unchanged",
  args: z.object({ r: answer.returns.shape.cart }),
  from: { r: [answer, "cart"] },
  claims: [{ actual: "r", at: "count", compare: "equal", expected: { from: "r.count" } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart count is unchanged"),
    });
    await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({
      actual_from: "from:the-app-answers@3.cart.count",
      expected_from: "from:the-app-answers@3.cart.count",
      outcome: "broken",
      reason: "both sides read from:the-app-answers@3.cart.count, so the claim compares a value with itself",
    });
  });
});

describe("an expected value every actual holds breaks", () => {
  it("breaks a boolean observe computed as the expected value", async () => {
    const rootDir = await project({
      "features/steps/the-banner-is-visible.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the banner is visible",
  args: z.object({}),
  observe() { return { visible: true, yes: true }; },
  claims: [{ actual: "visible", compare: "equal", expected: { observe: "yes" } }],
});
`,
      "features/t.feature": feature("Then the banner is visible"),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({
      outcome: "broken",
      reason:
        "the expected value observe:yes is a boolean observe computed, which is a judgment made in code: return the thing measured and let the claim compare it",
    });
  });
});

describe("a matches pattern runs where it can be stopped", () => {
  it("breaks a pattern that backtracks past the step's deadline, and the run ends", async () => {
    const rootDir = await project({
      "features/steps/the-output-matches.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the output matches {re:string}",
  args: z.object({ re: z.string(), out: z.string() }),
  from: { out: [answer, "out"] },
  timeout: 1000,
  claims: [{ actual: "out", compare: "matches", expected: "re" }],
});
`,
      "features/t.feature": feature("When the app answers", 'Then the output matches "^(a+)+$"'),
    });
    const started = Date.now();
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.exitCode).toBe(1);
    const claim = lastClaimStep(rootDir).claims[0];
    expect(claim.outcome).toBe("broken");
    expect(claim.reason).toMatch(/^matches did not finish within \d+ms \(the time left of the step's deadline\), so nukadoko stopped the pattern$/);
  });
});

describe("a claim step's error kind says what failed", () => {
  it("is unobserved when observe threw, and timeout when observe ran past the deadline", async () => {
    const rootDir = await project({
      "features/steps/it-throws.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the page throws {n:int}",
  args: z.object({ n: z.number() }),
  observe() { throw new Error("no page"); },
  claims: [{ actual: "count", compare: "equal", expected: "n" }],
});
`,
      "features/steps/it-hangs.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the page hangs {n:int}",
  args: z.object({ n: z.number() }),
  timeout: 200,
  observe() { return new Promise(() => {}); },
  claims: [{ actual: "count", compare: "equal", expected: "n" }],
});
`,
      "features/t.feature": [
        "Feature: claims",
        "  Scenario: throws",
        "    Then the page throws 1",
        "  Scenario: hangs",
        "    Then the page hangs 1",
        "",
      ].join("\n"),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const run = latestRunJson(rootDir);
    const [threw, hung] = run.scenarios.map((scenario: Record<string, any>) => scenario.steps.at(-1));
    expect(threw.error).toEqual({ kind: "unobserved", message: "the step observed nothing, so no claim was judged: no page" });
    expect(threw.claims[0].outcome).toBe("unobserved");
    expect(hung.error.kind).toBe("timeout");
    expect(hung.claims[0].outcome).toBe("unobserved");
  });
});

describe("each records why each item was selected or left out", () => {
  it("records every item, and the summary names the where claims and the item claims with their values", async () => {
    const rootDir = await project({
      "features/steps/every-food-row-is-small.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "every {kind:string} row is at most {limit:int}",
  args: z.object({ kind: z.string(), limit: z.number() }),
  observe() { return { rows: [{ kind: "food", total: 4 }, { kind: "rent", total: 100 }, { kind: "food", total: 12 }] }; },
  claims: [{ actual: "rows", each: {
    where: [{ actual: "kind", compare: "equal", expected: "kind" }],
    claims: [{ actual: "total", compare: "at-most", expected: "limit" }],
  } }],
});
`,
      "features/t.feature": feature('Then every "food" row is at most 10'),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const claim = lastClaimStep(rootDir).claims[0];
    expect(claim.each.results.map((item: Record<string, unknown>) => [item.index, item.selected])).toEqual([
      [0, true],
      [1, false],
      [2, true],
    ]);
    expect(claim.each.results[1].where[0]).toMatchObject({ actual: "rent", actual_from: "observe:rows.1.kind", outcome: "broken" });
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain(
      '  - each of observe:rows (3 items, 2 selected) where kind equal "food" (sentence:kind): total at-most 10 (sentence:limit) broken',
    );
  });
});

describe("what defineStep validated is what runs", () => {
  it("refuses a step file that exports a copy of a step with other claims", async () => {
    const rootDir = await project({
      "features/steps/the-banner-looks-right.ts": `import { defineStep, z } from "nukadoko";
const valid = defineStep({
  pattern: "the banner looks right",
  args: z.object({}),
  observe() { return { ok: true, n: 0 }; },
  claims: [{ actual: "n", compare: "equal", expected: { literal: "right" } }],
});
export default { ...valid, claims: [{ actual: "ok", compare: "equal", expected: { literal: true } }] };
`,
      "features/t.feature": feature("Then the banner looks right"),
    });
    const message =
      "features/steps/the-banner-looks-right.ts: the default export is a copy of a step, not the step defineStep returned, so nothing validated what it declares. Export what defineStep returned, and pass any change to defineStep instead";
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain("the default export is a copy of a step, not the step defineStep returned");
    const ran = await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr).toContain(message);
  });

  it("refuses a change to a claim after defineStep", async () => {
    const rootDir = await project({
      "features/steps/the-banner-looks-right.ts": `import { defineStep, z } from "nukadoko";
const valid = defineStep({
  pattern: "the banner looks right",
  args: z.object({}),
  observe() { return { ok: true, n: 0 }; },
  claims: [{ actual: "n", compare: "equal", expected: { literal: "right" } }],
});
valid.claims[0].expected = { literal: 0 };
export default valid;
`,
      "features/t.feature": feature("Then the banner looks right"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain("Cannot assign to read only property 'expected'");
  });

  it("refuses a where claim that is the same claim as an item claim", async () => {
    const rootDir = await project({
      "features/steps/every-item-is-titled.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "every item is titled {title:string}",
  args: z.object({ title: z.string(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.items", each: {
    where: [{ actual: "title", compare: "equal", expected: "title" }],
    claims: [{ actual: "title", compare: "equal", expected: "title" }],
  } }],
});
`,
      "features/t.feature": feature("When the app answers", 'Then every item is titled "a"'),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.stdout + checked.stderr).toContain(
      "defineStep claims[0].each.where[0] is the same claim as claims[0].each.claims[0], so every item where selects holds it and the claim says nothing. Select by another value, or drop where.",
    );
  });

  it.each([
    ["no item is unpaid", "cart.count", "at-least", "0", "no"],
    ["the cart is empty", "cart.items", "not-equal", "[]", "empty"],
  ])('refuses "%s" read as %s through the word table with a compare other than equal', async (pattern, actual, compare, literal, word) => {
    const rootDir = await project({
      "features/steps/it-says.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "${pattern}",
  args: z.object({ cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "${actual}", compare: "${compare}", expected: { literal: ${literal} } }],
});
`,
      "features/t.feature": feature("When the app answers", `Then ${pattern}`),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.stdout + checked.stderr).toContain(
      `defineStep claims[0].expected is the literal ${literal}, which the word "${word}" fixes, and claims[0].compare is "${compare}". A value a word fixes is compared with equal alone: another compare against it holds for nearly anything, and the word does not show it.`,
    );
  });
});
