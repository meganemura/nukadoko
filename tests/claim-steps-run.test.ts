import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { SNAPSHOT_MAX_DEPTH } from "../src/step/snapshot.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  ensureNukadokoShim,
  latestRunDir,
  latestRunJson,
  removeTempDir,
  repoRoot,
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
      `defineStep claims[0].expected reads args.code, and its schema rewrites the value the line states or an earlier step returned (${rewrite}), so step code would decide what the claim compares. Take the rewrite out of the schema, or read the line's text with expected_view (text, lines, json, comma-list).`,
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

  it("cuts a broken claim's values after redacting them, so no part of a secret reaches the failure, the output, or the summary", async () => {
    const token = "tok_LIVEabcdefghijklmnopqrstuvwxyz0123";
    for (const pad of [130, 110]) {
      const rootDir = await project({
        "nukadoko.config.ts": 'import { defineConfig } from "nukadoko";\nexport default defineConfig({ envFiles: [".env"] });\n',
        ".env": `API_TOKEN=${token}\n`,
        "features/steps/banner.ts": `import { z } from "zod";
import { defineStep } from "nukadoko";
export default defineStep({
  pattern: "the service prints its banner",
  args: z.object({}),
  returns: z.object({ banner: z.string() }),
  mutates: false,
  async run({ env }) { return { banner: "x".repeat(${pad}) + env.API_TOKEN + " end" }; },
});
`,
        "features/steps/banner-reads.ts": `import { z } from "zod";
import { defineStep } from "nukadoko";
import banner from "./banner.ts";
export default defineStep({
  pattern: "the banner reads {text:string}",
  args: z.object({ text: z.string(), banner: z.string() }),
  from: { banner: [banner, "banner"] },
  claims: [{ actual: "banner", compare: "equal", expected: "text" }],
});
`,
        "features/t.feature": feature("Given the service prints its banner", `Then the banner reads "${"x".repeat(pad)}tok_OTHER"`),
      });
      const result = await cli(rootDir, ["run", "features/t.feature"]);
      expect(result.exitCode).toBe(1);
      const message: string = lastClaimStep(rootDir).error.message;
      const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
      for (const text of [message, result.stdout, result.stderr, summary]) expect(text).not.toContain("tok_LIVE");
      expect(message).toContain("{{secret.API_TOKEN}}");
    }
  });

  it("names where a broken equal on a multi-line text first differs, in the failure and the summary", async () => {
    const rootDir = await project({
      "features/steps/the-report-reads.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the report reads",
  args: z.object({ expected: z.string() }),
  observe() { return { report: "food: 5.5\\nrent: 100" }; },
  claims: [{ actual: "report", compare: "equal", expected: "expected" }],
});
`,
      "features/t.feature": feature("Then the report reads", '  """', "  food: 5.5", "  rent: 101", '  """'),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const message: string = lastClaimStep(rootDir).error.message;
    expect(message.split("\n")[0]).toBe(
      'claim broken: "food: 5.5\\nrent: 100" (observe:report) equal "food: 5.5\\nrent: 101" (sentence:expected); first difference at line 2: actual "rent: 100", expected "rent: 101"',
    );
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain('(sentence:expected) broken; first difference at line 2: actual "rent: 100", expected "rent: 101"; measured: none');
  });

  it("names the row a broken has-same-items on a table does not share, in the failure and the summary", async () => {
    const rootDir = await project({
      "features/steps/the-orders-are.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the orders are",
  args: z.object({ table: z.array(z.array(z.string())) }),
  observe() { return { rows: [["id", "name"], ["1", "lamp"], ["4", "chair"], ["2", "mug"]] }; },
  claims: [{ actual: "rows", compare: "has-same-items", expected: "table" }],
});
`,
      "features/t.feature": feature("Then the orders are", "  | id | name |", "  | 2  | mug  |", "  | 1  | lamp |"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const message: string = lastClaimStep(rootDir).error.message;
    expect(message.split("\n")[0]).toBe(
      'claim broken: [["id","name"],["1","lamp"],["4","chair"],["2","mug"]] (observe:rows) has-same-items [["id","name"],["2","mug"],["1","lamp"]] (sentence:table); 1 actual item is extra: ["4","chair"] (item 2)',
    );
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain('(sentence:table) broken; 1 actual item is extra: ["4","chair"] (item 2); measured: none');
  });

  it("names the row inserted into a list a broken equal on a table reads in order, not a difference at every row after it", async () => {
    const rootDir = await project({
      "features/steps/the-orders-in-order-are.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the orders, in order, are",
  args: z.object({ table: z.array(z.array(z.string())) }),
  observe() { return { rows: [["id", "name"], ["1", "lamp"], ["4", "chair"], ["2", "mug"]] }; },
  claims: [{ actual: "rows", compare: "equal", expected: "table" }],
});
`,
      "features/t.feature": feature("Then the orders, in order, are", "  | id | name |", "  | 1  | lamp |", "  | 2  | mug  |"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const message: string = lastClaimStep(rootDir).error.message;
    expect(message.split("\n")[0]).toBe(
      'claim broken: [["id","name"],["1","lamp"],["4","chair"],["2","mug"]] (observe:rows) equal [["id","name"],["1","lamp"],["2","mug"]] (sentence:table); 1 actual item is extra: ["4","chair"] (item 2)',
    );
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain('(sentence:table) broken; 1 actual item is extra: ["4","chair"] (item 2); measured: none');
  });
});

describe("a value that is not plain JSON leaves the claim unjudged, and the record says which part", () => {
  it("leaves a Date observe returned unjudged, and records no actual", async () => {
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
      outcome: "unjudged",
      reason: "observe:when is a Date, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads",
      measured: null,
    });
    expect(step.error.kind).toBe("claim_unjudged");
  });

  it("leaves a bigint on either side unjudged, naming it", async () => {
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
      outcome: "unjudged",
      reason: "observe:total is the bigint 12345678901234567890n, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads",
    });
  });

  it("leaves an array item that is undefined unjudged, and does not crash", async () => {
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
    expect(step.error.kind).toBe("claim_unjudged");
    expect(step.claims[0]).toMatchObject({
      outcome: "unjudged",
      reason: "observe:history.0 is undefined, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads",
    });
  });
});

describe("a schema that can change the value a claim measures is refused at defineStep, wherever it sits", () => {
  const REFINE = "a refine, superRefine, or check on an object or an array, which can change the value it is handed";
  const DEFAULT = "a default (default or prefault), which fills a value that is missing";
  const keyCases: readonly [string, string, string][] = [
    ["a refine on the from key", "answer.returns.shape.cart.refine((cart) => { cart.count = 5; return true; })", REFINE],
    ["a superRefine on an array inside it", "z.object({ count: z.number(), items: z.array(z.unknown()).superRefine(() => {}) })", REFINE],
    ["a default inside it", "z.object({ count: z.number().default(5), items: z.array(z.unknown()) })", DEFAULT],
    ["a prefault inside it", "z.object({ count: z.number().prefault(5), items: z.array(z.unknown()) })", DEFAULT],
  ];

  it.each(keyCases)("refuses %s", async (_name, schema, words) => {
    const rootDir = await project({
      "features/steps/it-counts.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "it counts {code:int}",
  args: z.object({ code: z.number(), cart: ${schema} }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.count", compare: "equal", expected: "code" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then it counts 5"),
    });
    const result = await cli(rootDir, ["check", "features/t.feature"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      `defineStep claims[0].actual reads args.cart, and its schema rewrites the value the claim measures (${words}), so step code would decide what the claim compares. Take the rewrite out of the schema.`,
    );
  });

  const rootCases: readonly [string, string][] = [
    ["refine", ".refine((args) => { args.code = args.cart.count; return true; })"],
    ["superRefine", ".superRefine((args) => { args.code = args.cart.count; })"],
    ["check", ".check((ctx) => { ctx.value.code = ctx.value.cart.count; })"],
  ];

  it.each(rootCases)("refuses a %s on the args object, which every key passes through", async (_name, suffix) => {
    const rootDir = await project({
      "features/steps/it-counts.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "it counts {code:int}",
  args: z.object({ code: z.number(), cart: answer.returns.shape.cart })${suffix},
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.count", compare: "equal", expected: "code" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then it counts 5"),
    });
    const result = await cli(rootDir, ["check", "features/t.feature"]);
    expect(result.stdout + result.stderr).toContain(
      "defineStep claims[0].actual reads args.cart, and the args schema itself rewrites the value the claim measures (a refine, superRefine, or check on the args object, which can change the value it is handed), so step code would decide what the claim compares. Take the rewrite out of the args schema.",
    );
  });
});

describe("a claim judges one snapshot per side, taken where the value comes from", () => {
  it("leaves the claim unjudged when the args schema changed a value a claim reads after defineStep, and records the value it was given", async () => {
    const rootDir = await project({
      "features/steps/it-counts.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
const args = z.object({ code: z.number(), cart: answer.returns.shape.cart });
const step = defineStep({
  pattern: "it counts {code:int}",
  args,
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.count", compare: "equal", expected: "code" }],
});
(args as any).def.shape.cart = z.object({ count: z.number(), items: z.array(z.unknown()) }).transform((cart) => ({ ...cart, count: 5 }));
export default step;
`,
      "features/t.feature": feature("When the app answers", "Then it counts 5"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const step = lastClaimStep(rootDir);
    expect(step.error.kind).toBe("claim_unjudged");
    expect(step.claims[0]).toMatchObject({
      actual: 1,
      expected: 5,
      outcome: "unjudged",
      reason: "the args schema changed args.cart at count from the value nukadoko read before it ran, so the claim was not judged",
    });
  });

  it("breaks a claim whose actual from key observe also returned, and judges the claim that reads observe", async () => {
    const rootDir = await project({
      "features/steps/the-cart-holds.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart holds {n:int} items",
  args: z.object({ n: z.number(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  observe() { return { cart: { count: 3 }, seen: 3 }; },
  claims: [{ actual: "cart.count", compare: "equal", expected: "n" }, { actual: "seen", compare: "equal", expected: "n" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart holds 3 items"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const [, step] = latestRunJson(rootDir).scenarios[0].steps;
    expect(step.claims.map((claim: { outcome: string }) => claim.outcome)).toEqual(["broken", "held"]);
    expect(step.claims[0].reason).toContain('observe returned "cart", and from has a key of the same name');
  });

  it("refuses at import a step whose observe no claim reads, and nuka check names the file", async () => {
    const rootDir = await project({
      "features/steps/the-cart-holds.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart holds {n:int} items",
  args: z.object({ n: z.number(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  observe() { return { cart: { count: 3 } }; },
  claims: [{ actual: "cart.count", compare: "equal", expected: "n" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart holds 3 items"),
    });
    const result = await cli(rootDir, ["check"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("step-file-import-failed\tfeatures/steps/the-cart-holds.ts\tdefineStep the step has observe, and no claim reads what it returns");
  });

  it("judges the value the producing step returned, whatever observe does to its own copy", async () => {
    const rootDir = await project({
      "features/steps/the-cart-holds.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart holds {n:int} items",
  args: z.object({ n: z.number(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  observe({}, { cart }) { (cart as any).count = 3; return { seen: (cart as any).count }; },
  claims: [{ actual: "cart.count", compare: "equal", expected: "n" }, { actual: "seen", compare: "equal", expected: "n" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart holds 3 items"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const [producer, step] = latestRunJson(rootDir).scenarios[0].steps;
    expect(step.claims[0]).toMatchObject({ actual: 1, expected: 3, outcome: "broken" });
    const record = JSON.parse(await readFile(path.join(latestRunDir(rootDir), producer.record, "record.json"), "utf8")) as { result: { cart: { count: number } } };
    expect(record.result.cart.count).toBe(1);
  });

  it("judges a from value as the producing step returned it, though the step changes it afterwards or a step before the claim changes its own copy", async () => {
    const rootDir = await project({
      "features/steps/i-fetch-the-cart.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  description: "Fetches the cart",
  pattern: "I fetch the cart",
  args: z.object({}),
  returns: z.object({ items: z.any() }),
  mutates: false,
  run() {
    const items: string[] = [];
    setTimeout(() => items.push("apple"), 30);
    return { items };
  },
});
`,
      "features/steps/i-add-to-my-copy.ts": `import { defineStep, z } from "nukadoko";
import fetch from "./i-fetch-the-cart.ts";
export default defineStep({
  description: "Changes the cart it received",
  pattern: "I add apple to my copy",
  args: z.object({ items: z.any() }),
  from: { items: [fetch, "items"] },
  mutates: false,
  async run({}, { items }) {
    items.push("apple");
    await new Promise((resolve) => setTimeout(resolve, 100));
  },
});
`,
      "features/steps/the-cart-holds.ts": `import { defineStep, z } from "nukadoko";
import fetch from "./i-fetch-the-cart.ts";
export default defineStep({
  pattern: "the cart holds {item:string}",
  args: z.object({ items: z.array(z.string()), item: z.string() }),
  from: { items: [fetch, "items"] },
  claims: [{ actual: "items", compare: "has-item", expected: "item" }],
});
`,
      "features/t.feature": feature("When I fetch the cart", "And I add apple to my copy", 'Then the cart holds "apple"'),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const [producer, , step] = latestRunJson(rootDir).scenarios[0].steps;
    expect(step.claims[0]).toMatchObject({ actual: [], expected: "apple", outcome: "broken" });
    const record = JSON.parse(await readFile(path.join(latestRunDir(rootDir), producer.record, "record.json"), "utf8")) as { result: { items: string[] } };
    expect(record.result.items).toEqual([]);
  });

  it("leaves every claim unjudged, and does not call observe, when an input observe would receive cannot be copied", async () => {
    const rootDir = await project({
      "features/steps/i-connect.ts": `import { defineStep, z } from "nukadoko";
class Client { count = 1; send = () => 1; }
export default defineStep({
  description: "Connects",
  pattern: "I connect",
  args: z.object({}),
  returns: z.object({ client: z.any(), list: z.any() }),
  mutates: false,
  run() {
    return { client: new Client(), list: new Proxy([], {}) };
  },
});
`,
      "features/steps/the-client-counts.ts": `import { defineStep, z } from "nukadoko";
import connect from "./i-connect.ts";
export default defineStep({
  pattern: "the client counts {n:int}",
  args: z.object({ client: z.any(), n: z.number() }),
  from: { client: [connect, "client"] },
  observe({}, { client }) { globalThis.observed = true; return { count: client.count }; },
  claims: [{ actual: "count", compare: "equal", expected: "n" }],
});
`,
      "features/steps/the-list-is-empty.ts": `import { defineStep, z } from "nukadoko";
import connect from "./i-connect.ts";
export default defineStep({
  pattern: "the list has {n:int} items",
  args: z.object({ list: z.any(), n: z.number() }),
  from: { list: [connect, "list"] },
  observe({}, { list }) { return { count: list.length }; },
  claims: [{ actual: "count", compare: "equal", expected: "n" }],
});
`,
      "features/t.feature": feature("When I connect", "Then the client counts 1"),
      "features/u.feature": feature("When I connect", "Then the list has 0 items"),
    });
    for (const [file, key, problem] of [
      ["features/t.feature", "client", "holds a function at send"],
      ["features/u.feature", "list", "is a Proxy"],
    ] as const) {
      const result = await cli(rootDir, ["run", file]);
      expect(result.exitCode).toBe(1);
      const step = lastClaimStep(rootDir);
      expect(step.error.kind).toBe("claim_unjudged");
      expect(step.observation).toBe("unobserved");
      expect(step.attempts).toBe(0);
      expect(step.claims[0]).toMatchObject({
        outcome: "unjudged",
        reason: `observe would receive args.${key}, which ${problem}, and observe receives only copies of its inputs, so observe did not run and no claim was judged`,
      });
    }
    expect((globalThis as { observed?: boolean }).observed).toBeUndefined();
  });

  it("leaves a Proxy observe returned unjudged, at the root or inside, and runs no trap that answers otherwise", async () => {
    const rootDir = await project({
      "features/steps/the-list-includes.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the list includes {name:string}",
  args: z.object({ name: z.string() }),
  observe() { return { list: new Proxy(["bread"], { get: (target, key) => (key === "0" ? "milk" : Reflect.get(target, key)) }) }; },
  claims: [{ actual: "list", compare: "has-item", expected: "name" }],
});
`,
      "features/steps/the-page-includes.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the page includes {name:string}",
  args: z.object({ name: z.string() }),
  observe() { return new Proxy({ list: ["milk"] }, { getOwnPropertyDescriptor() { throw new Error("descriptor trap ran"); } }); },
  claims: [{ actual: "list", compare: "has-item", expected: "name" }],
});
`,
      "features/t.feature": [
        "Feature: claims",
        "  Scenario: inside",
        '    Then the list includes "milk"',
        "  Scenario: root",
        '    Then the page includes "milk"',
        "",
      ].join("\n"),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const [inside, root] = latestRunJson(rootDir).scenarios.map((scenario: Record<string, any>) => scenario.steps.at(-1));
    expect(inside.error.kind).toBe("claim_unjudged");
    expect(inside.claims[0]).toMatchObject({
      outcome: "unjudged",
      reason: "observe:list is a Proxy, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads",
    });
    expect(inside.claims[0]).not.toHaveProperty("actual");
    expect(root.error.kind).toBe("claim_unjudged");
    expect(root.claims[0]).toMatchObject({
      outcome: "unjudged",
      reason: "the value observe returned is a Proxy, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads",
    });
  });

  it("leaves a value nested past the limit unjudged, naming the limit, where the record writer would overflow the stack", async () => {
    const rootDir = await project({
      "features/steps/the-value-is-nested.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the value is nested",
  args: z.object({}),
  observe() {
    let v: unknown = [];
    let w: unknown = [];
    for (let i = 0; i < 2000; i += 1) { v = [v]; w = [w]; }
    return { v, w };
  },
  claims: [{ actual: "v", compare: "equal", expected: { observe: "w" } }],
});
`,
      "features/t.feature": feature("Then the value is nested"),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const step = lastClaimStep(rootDir);
    expect(step.error.kind).toBe("claim_unjudged");
    expect(step.claims[0]).toMatchObject({
      outcome: "unjudged",
      reason: `observe:v nests deeper than ${SNAPSHOT_MAX_DEPTH} levels, so the claim was not judged: the record keeps no value nested that deep`,
    });
  });

  it("records the value observe returned as it was when it returned, not after a callback changed it", async () => {
    const rootDir = await project({
      "features/steps/the-list-includes.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the list includes {name:string}",
  args: z.object({ name: z.string() }),
  async observe() {
    const list = ["milk"];
    setImmediate(() => { list[0] = "bread"; });
    return { list };
  },
  claims: [{ actual: "list", compare: "has-item", expected: "name" }],
});
`,
      "features/t.feature": feature('Then the list includes "milk"'),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(0);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({ actual: ["milk"], outcome: "held" });
  });

  it("keeps each poll reading's own value, though observe returns one array it changes each time", async () => {
    const rootDir = await project({
      "features/steps/the-list-includes.ts": `import { defineStep, z } from "nukadoko";
const shown = ["x", "y", "milk"];
const shared: string[] = [];
let calls = 0;
export default defineStep({
  pattern: "the list includes {name:string}",
  args: z.object({ name: z.string() }),
  poll: { timeout_ms: 10000 },
  observe() {
    shared.length = 0;
    shared.push(shown[Math.min(calls, shown.length - 1)]!);
    calls += 1;
    return { list: shared };
  },
  claims: [{ actual: "list", compare: "has-item", expected: "name" }],
});
`,
      "features/t.feature": feature('Then the list includes "milk"'),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const step = lastClaimStep(rootDir);
    const record = JSON.parse(await readFile(path.join(latestRunDir(rootDir), step.record, "record.json"), "utf8")) as { readings: Record<string, unknown>[] };
    expect(record.readings.map((reading) => reading.actuals)).toEqual([[{ value: ["x"] }], [{ value: ["y"] }], [{ value: ["milk"] }], [{ value: ["milk"] }]]);
  });
});

/** A step that lists rows the way code that maps a database row does: an
 * optional field that is not set is a key whose value is undefined. */
const USERS_STEP = `import { defineStep, z } from "nukadoko";
export default defineStep({
  description: "Lists the users",
  pattern: "I list the users",
  args: z.object({}),
  returns: z.object({ users: z.array(z.object({ name: z.string(), active: z.boolean(), nickname: z.string().optional(), title: z.string() })) }),
  mutates: false,
  run() {
    const rows = [{ name: "a", active: true, nickname: "al", title: "x" }, { name: "b", active: true, title: "y" }];
    return { users: rows.map((row) => ({ name: row.name, active: row.active, nickname: row.nickname, title: row.title })) };
  },
});
`;

describe("a claim takes a snapshot of the place it reads, and the args schema is compared there alone", () => {
  it("reads and records one value for a dotted path and for the same path through at, beside a key that is undefined", async () => {
    const step = (name: string, claim: string) => `import { defineStep, z } from "nukadoko";
import list from "./i-list-the-users.ts";
export default defineStep({
  pattern: "the first user is named {name:string} ${name}",
  args: z.object({ users: list.returns.shape.users, name: z.string() }),
  from: { users: [list, "users"] },
  claims: [${claim}],
});
`;
    const rootDir = await project({
      "features/steps/i-list-the-users.ts": USERS_STEP,
      "features/steps/first-dotted.ts": step("dotted", '{ actual: "users.0.name", compare: "equal", expected: "name" }'),
      "features/steps/first-at.ts": step("by at", '{ actual: "users", at: "0.name", compare: "equal", expected: "name" }'),
      "features/t.feature": feature("When I list the users", 'Then the first user is named "a" dotted', 'And the first user is named "a" by at'),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(0);
    const [, dotted, byAt] = latestRunJson(rootDir).scenarios[0].steps;
    expect(dotted.claims[0]).toMatchObject({ actual: "a", actual_from: "from:i-list-the-users@3.users.0.name", outcome: "held" });
    expect(byAt.claims[0]).toMatchObject({ actual: "a", actual_from: "from:i-list-the-users@3.users.0.name", at: "0.name", outcome: "held" });
    expect(byAt.claims[0].measured).toEqual(dotted.claims[0].measured);
  });

  it("judges every item of an array whose items leave an optional key undefined, and names the place of a value that is not JSON", async () => {
    const rootDir = await project({
      "features/steps/i-list-the-users.ts": USERS_STEP,
      "features/steps/every-user-is-active.ts": `import { defineStep, z } from "nukadoko";
import list from "./i-list-the-users.ts";
export default defineStep({
  pattern: "every user is active true",
  args: z.object({ users: list.returns.shape.users }),
  from: { users: [list, "users"] },
  claims: [{ actual: "users", each: { claims: [{ actual: "active", compare: "equal", expected: { literal: true } }] } }],
});
`,
      "features/steps/the-user-is-named.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the user is named {name:string}",
  args: z.object({ name: z.string() }),
  observe() { return { user: { name: "a", seen: new Date(0) }, other: { name: "a", seen: new Date(0) } }; },
  claims: [{ actual: "user", at: "name", compare: "equal", expected: "name" }, { actual: "other", compare: "not-equal", expected: "name" }],
});
`,
      "features/t.feature": feature("When I list the users", "Then every user is active true"),
      "features/u.feature": feature('Then the user is named "a"'),
    });
    expect((await cli(rootDir, ["run", "features/t.feature"])).exitCode).toBe(0);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({ outcome: "held", each: { items: 2, selected: 2 } });
    expect((await cli(rootDir, ["run", "features/u.feature"])).exitCode).toBe(1);
    const claims = lastClaimStep(rootDir).claims;
    expect(claims[0]).toMatchObject({ actual: "a", outcome: "held" });
    expect(claims[1]).toMatchObject({
      outcome: "unjudged",
      reason: "observe:other.seen is a Date, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads",
    });
  });

  it("judges an each through an args schema that names only the field its claims read, and leaves it unjudged when the schema changed a place a where reads", async () => {
    const rootDir = await project({
      "features/steps/i-list-the-users.ts": USERS_STEP,
      "features/steps/every-user-is-active.ts": `import { defineStep, z } from "nukadoko";
import list from "./i-list-the-users.ts";
export default defineStep({
  pattern: "every user is active true",
  args: z.object({ users: z.array(z.object({ active: z.boolean() })) }),
  from: { users: [list, "users"] },
  claims: [{ actual: "users", each: { claims: [{ actual: "active", compare: "equal", expected: { literal: true } }] } }],
});
`,
      "features/steps/every-titled-user-is-active.ts": `import { defineStep, z } from "nukadoko";
import list from "./i-list-the-users.ts";
export default defineStep({
  pattern: "every user titled {title:string} is active true",
  args: z.object({ title: z.string(), users: z.array(z.object({ active: z.boolean() })) }),
  from: { users: [list, "users"] },
  claims: [{ actual: "users", each: { where: [{ actual: "title", compare: "equal", expected: "title" }], claims: [{ actual: "active", compare: "equal", expected: { literal: true } }] } }],
});
`,
      "features/t.feature": feature("When I list the users", "Then every user is active true"),
      "features/u.feature": feature("When I list the users", 'Then every user titled "x" is active true'),
    });
    expect((await cli(rootDir, ["run", "features/t.feature"])).exitCode).toBe(0);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({ outcome: "held", each: { items: 2, selected: 2 } });
    expect((await cli(rootDir, ["run", "--no-check", "features/u.feature"])).exitCode).toBe(1);
    const step = lastClaimStep(rootDir);
    expect(step.error.kind).toBe("claim_unjudged");
    expect(step.claims[0]).toMatchObject({
      outcome: "unjudged",
      reason: "the args schema changed args.users at 0.title from the value nukadoko read before it ran, so the claim was not judged",
      each: { items: 2, selected: 0, results: [] },
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

describe("a matches pattern runs where it can be stopped, within the step's deadline", () => {
  it("leaves a pattern that backtracks past the step's deadline unjudged, and the run ends", async () => {
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
    const step = lastClaimStep(rootDir);
    expect(step.error.kind).toBe("claim_unjudged");
    expect(step.claims[0].outcome).toBe("unjudged");
    expect(step.claims[0].reason).toMatch(/^matches did not finish within \d+ms \(the time left of the step's deadline\), so nukadoko stopped the pattern$/);
  });

  it("stops judging every item once the deadline passed, without a worker for each item, and names how many were not judged", async () => {
    const rootDir = await project({
      "features/steps/every-line-matches.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "all {n:int} lines match {re:string}",
  args: z.object({ n: z.number(), re: z.string() }),
  timeout: 1500,
  observe() { return { lines: Array.from({ length: 400 }, () => "a".repeat(34) + "!"), total: 400 }; },
  poll: false,
  claims: [
    { actual: "lines", each: { claims: [{ compare: "matches", expected: "re" }] } },
    { actual: "total", compare: "equal", expected: "n" },
  ],
});
`,
      "features/t.feature": feature('Then all 400 lines match "^(a+)+$"'),
    });
    const started = Date.now();
    await cli(rootDir, ["run", "features/t.feature"]);
    expect(Date.now() - started).toBeLessThan(5_000);
    const step = lastClaimStep(rootDir);
    expect(step.error.kind).toBe("claim_unjudged");
    expect(step.claims[0]).toMatchObject({
      outcome: "unjudged",
      reason: "the step's deadline passed, so nukadoko stopped judging: 400 of 400 items were not judged",
    });
    expect(step.claims[1]).toMatchObject({
      outcome: "unjudged",
      reason: "the step's deadline passed, so nukadoko stopped judging: 1 of 2 claims were not judged",
    });
  });
});

describe("a claim step's error kind says what failed", () => {
  it("is unobserved when observe threw, and timeout, with each claim unjudged, when observe ran past the deadline", async () => {
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
    expect(hung.claims[0]).toMatchObject({ outcome: "unjudged" });
    expect(hung.claims[0].reason).toMatch(/ timed out after 200ms \(the step's own timeout\) while observe ran, so no claim was judged$/);
    expect(hung.observation).toBe("unobserved");
  });

  it("leaves each claim unjudged when the deadline passes while a poll reads, and keeps the readings read before it", async () => {
    const rootDir = await project({
      "features/steps/the-counter-shows.ts": `import { defineStep, z } from "nukadoko";
let calls = 0;
export default defineStep({
  pattern: "the counter shows {n:int}",
  args: z.object({ n: z.number() }),
  timeout: 1000,
  poll: { timeout_ms: 10000 },
  observe() {
    calls += 1;
    return calls <= 2 ? { count: 0 } : new Promise(() => {});
  },
  claims: [{ actual: "count", compare: "equal", expected: "n" }],
});
`,
      "features/t.feature": feature("Then the counter shows 3"),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const step = lastClaimStep(rootDir);
    expect(step.error.kind).toBe("timeout");
    expect(step.claims[0]).toMatchObject({ outcome: "unjudged" });
    expect(step.claims[0].reason).toMatch(
      / timed out after 1000ms \(the step's own timeout\) while the poll read, so no claim was judged; the readings show what each reading before it read$/,
    );
    expect(step.observation).toBe("observed");
    expect(step.attempts).toBe(3);
    const record = JSON.parse(await readFile(path.join(latestRunDir(rootDir), step.record, "record.json"), "utf8")) as { readings: Record<string, unknown>[] };
    expect(record.readings.map((reading) => [reading.attempt, reading.held, reading.actuals])).toEqual([
      [1, false, [{ value: 0 }]],
      [2, false, [{ value: 0 }]],
    ]);
  });

  it("ends a poll whose timeout is longer than the step's deadline before the deadline, and judges its last reading", async () => {
    const rootDir = await project({
      "features/steps/the-counter-shows.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the counter shows {n:int}",
  args: z.object({ n: z.number() }),
  timeout: 1000,
  poll: { timeout_ms: 10000 },
  observe() { return { count: 0 }; },
  claims: [{ actual: "count", compare: "equal", expected: "n" }],
});
`,
      "features/t.feature": feature("Then the counter shows 3"),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const step = lastClaimStep(rootDir);
    expect(step.error.kind).toBe("claim_broken");
    expect(step.claims[0]).toMatchObject({ actual: 0, expected: 3, outcome: "broken" });
    expect(step.observation).toBe("observed");
    expect(step.attempts).toBeGreaterThan(1);
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
      '  - each of observe:rows (3 items, 2 selected) where kind equal "food" (sentence:kind): total at-most 10 (sentence:limit) broken; item 2: 12 (observe:rows.2.total) at-most 10 (sentence:limit)',
    );
  });

  it("names the broken item by its index and its name field, with the value it held, in the summary and the failure", async () => {
    const rootDir = await project({
      "features/steps/every-call-is-the-first.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "every call has the counter {counter:string}",
  args: z.object({ counter: z.string() }),
  observe() { return { calls: [{ name: "helper", counter: "#1" }, { name: "caller", counter: "#2" }] }; },
  claims: [{ actual: "calls", each: { claims: [{ actual: "counter", compare: "equal", expected: "counter" }] } }],
});
`,
      "features/t.feature": feature('Then every call has the counter "#1"'),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const claim = lastClaimStep(rootDir).claims[0];
    expect(claim.each.results[0]).not.toHaveProperty("identity");
    expect(claim.each.results[1]).toMatchObject({ index: 1, outcome: "broken", identity: { field: "name", value: "caller" } });
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain('; item 1 (name "caller"): "#2" (observe:calls.1.counter) equal "#1" (sentence:counter)');
    expect(lastClaimStep(rootDir).error.message).toBe(
      'claim broken: each of observe:calls (2 items): counter equal "#1" (sentence:counter)\n  item 1 (name "caller"): "#2" (observe:calls.1.counter) equal "#1" (sentence:counter) broken',
    );
  });
});

describe("what the record shows of an object", () => {
  it("keeps an own __proto__ key that observe returned, so the record shows the value that was compared", async () => {
    const rootDir = await project({
      "features/steps/the-settings-differ-from.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the settings differ from",
  args: z.object({ docstring: z.string() }),
  poll: false,
  observe() { return { settings: JSON.parse('{"__proto__": {"admin": true}}') }; },
  claims: [{ actual: "settings", compare: "not-equal", expected: "docstring", expected_view: "json" }],
});
`,
      "features/t.feature": feature("Then the settings differ from", '  """', "  {}", '  """'),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const claim = lastClaimStep(rootDir).claims[0];
    expect(claim.outcome).toBe("held");
    expect(JSON.stringify(claim.actual)).toBe('{"__proto__":{"admin":true}}');
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain('{"__proto__":{"admin":true}}');
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

  it("refuses a change after defineStep below claims the step file froze itself", async () => {
    // Freezing in place stopped at an object that was frozen already, so the
    // claim inside stayed writable and could gain a where nothing validated.
    const rootDir = await project({
      "features/steps/every-item-is-titled.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
const each = { where: undefined as unknown, claims: [{ actual: "title", compare: "equal", expected: "title" }] };
const step = defineStep({
  pattern: "every item is titled {title:string}",
  args: z.object({ title: z.string(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: Object.freeze([{ actual: "cart.items", each }]) as any,
});
each.where = [{ actual: "title", compare: "equal", expected: "title" }];
export default step;
`,
      "features/t.feature": feature("When the app answers", 'Then every item is titled "a"'),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain("Cannot assign to read only property 'where'");
  });

  it("refuses a getter in a claim, which could answer validation one way and the run another", async () => {
    const rootDir = await project({
      "features/steps/the-cart-has-no-items.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
let reads = 0;
const claim = { actual: "cart.count", get compare() { reads += 1; return reads === 1 ? "equal" : "at-least"; }, expected: { literal: 0 } };
export default defineStep({
  pattern: "the cart has no items",
  args: z.object({ cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [claim as any],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart has no items"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain(
      "defineStep claims[0].compare is a getter or a setter. defineStep validates one frozen copy of the definition and the run reads only that copy, so the definition has to be plain data that can be copied without running code of its own.",
    );
  });

  it("refuses a change to a step's patterns after defineStep checked the literal against them", async () => {
    const rootDir = await project({
      "features/steps/the-cart-looks-right.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
const step = defineStep({
  pattern: "the cart count is 1",
  args: z.object({ cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.count", compare: "equal", expected: { literal: 1 } }],
});
(step.patterns as string[])[0] = "the cart looks right";
export default step;
`,
      "features/t.feature": feature("When the app answers", "Then the cart looks right"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain("Cannot assign to read only property '0'");
  });

  it.each([
    ["swaps in a where claim", `claims[0] = { actual: "cart.items", each: { where: [{ actual: "paid", compare: "equal", expected: { literal: true } }], claims: [{ actual: "paid", compare: "equal", expected: { literal: true } }] } };`, "Cannot assign to read only property '0'"],
    ["empties the claims", "claims.length = 0;", "Cannot assign to read only property 'length'"],
  ])("refuses a step file that brands its claims as a step and then %s after defineStep", async (_name, change, error) => {
    // The brand is a Symbol.for key any file can write. An object that
    // carries it is copied like any other, so nothing the step file still
    // holds is what runs.
    const rootDir = await project({
      "features/steps/every-item-is-paid.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
const claims: any = [{ actual: "cart.items", each: { claims: [{ actual: "paid", compare: "equal", expected: { literal: true } }] } }];
claims[Symbol.for("nukadoko.step")] = true;
const step = defineStep({
  pattern: "every item is paid true",
  args: z.object({ cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims,
});
${change}
export default step;
`,
      "features/t.feature": feature("When the app answers", "Then every item is paid true"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain(error);
  });

  it("copies an object that only carries the step brand, even where a step belongs, so from names no step", async () => {
    const rootDir = await project({
      "features/steps/the-cart-counts.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
const fake: any = { ...answer, [Symbol.for("nukadoko.step")]: true, returns: undefined, args: undefined, run: undefined };
export default defineStep({
  pattern: "the cart counts 1",
  args: z.object({ cart: answer.returns.shape.cart }),
  from: { cart: [fake, "cart"] },
  claims: [{ actual: "cart.count", compare: "equal", expected: { literal: 1 } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart counts 1"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain("from-structural-violation\tfeatures/steps/the-cart-counts.ts\tfrom.cart names something that is not a Step");
  });

  it("refuses a hole in claims, which validation would skip and the run would read as undefined", async () => {
    const rootDir = await project({
      "features/steps/the-cart-counts.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart counts 1",
  args: z.object({ cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  // eslint-disable-next-line no-sparse-arrays
  claims: [, { actual: "cart.count", compare: "equal", expected: { literal: 1 } }] as any,
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart counts 1"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain("defineStep claims[0] is a hole.");
  });

  it.each([
    ["att", `{ actual: "cart", att: "count", compare: "equal", expected: { literal: 1 } }`, 'claims[0] has the key "att", which a claim does not have. It has actual, view, at, count, compare, expected, expected_view'],
    ["wher", `{ actual: "cart.items", each: { wher: [], claims: [{ actual: "paid", compare: "equal", expected: { literal: true } }] } }`, 'claims[0].each has the key "wher", which each does not have. It has where, claims'],
    ["expect", `{ actual: "cart.items", each: { claims: [{ actual: "paid", compare: "equal", expected: { literal: true }, expect: 1 }] } }`, 'claims[0].each.claims[0] has the key "expect", which a claim on one item does not have. It has actual, view, at, count, compare, expected, expected_view'],
  ])("refuses a claim with the unknown key %s and names it", async (_key, claim, message) => {
    const rootDir = await project({
      "features/steps/the-cart-counts.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart counts 1 true",
  args: z.object({ cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [${claim}] as any,
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart counts 1 true"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain(`defineStep ${message}.`);
  });

  it.each([
    ["the same claim", `{ actual: "title", compare: "equal", expected: "title" }`, `{ actual: "title", compare: "equal", expected: "title" }`, "the item at title, the same place"],
    ["the same path through at", `{ actual: "title", compare: "equal", expected: "title" }`, `{ at: "title", compare: "equal", expected: "title" }`, "the item at title, the same place"],
    ["the same path through a view", `{ actual: "title", compare: "equal", expected: "title" }`, `{ actual: "title", view: "text", compare: "equal", expected: "title" }`, "the item at title, the same place"],
    ["the same path with another compare", `{ actual: "title", compare: "equal", expected: "title" }`, `{ actual: "title", compare: "not-equal", expected: "title" }`, "the item at title, the same place"],
    ["a place inside the one where reads", `{ compare: "equal", expected: "title" }`, `{ actual: "title", compare: "equal", expected: "title" }`, "the item at title, a place inside it"],
    ["the text where reads, which the claim reads as json", `{ actual: "title", compare: "contains-text", expected: "title" }`, `{ actual: "title", view: "json", at: "done", compare: "equal", expected: "title" }`, "the item at title.done, a place inside it"],
  ])("refuses a where clause that compares with equal or contains-text at a place that overlaps an item claim's: %s", async (_name, whereClaim, itemClaim, read) => {
    const rootDir = await project({
      "features/steps/every-item-is-titled.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "every item is titled {title:string}",
  args: z.object({ title: z.string(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.items", each: {
    where: [${whereClaim}],
    claims: [${itemClaim}],
  } }],
});
`,
      "features/t.feature": feature("When the app answers", 'Then every item is titled "a"'),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    const where = whereClaim.includes("actual") ? "the item at title" : "the item itself";
    const compare = whereClaim.includes("contains-text") ? "contains-text" : "equal";
    expect(checked.stdout + checked.stderr).toContain(
      `defineStep claims[0].each.where[0] selects by ${where} with ${compare}, and claims[0].each.claims[0] reads ${read}, so where selects the items by the value the claim then judges and "every item" says nothing. Select by another value, or drop where.`,
    );
  });

  it("judges an order where on the data when it leaves the claim a range, and breaks the claim when the where clause implies it", async () => {
    const step = (pattern: string, compare: string) => `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "${pattern}",
  args: z.object({ over: z.number(), bound: z.number() }),
  observe() { return { items: [{ price: 5 }, { price: 20 }, { price: ${pattern.includes("costly") ? 200 : 50} }] }; },
  claims: [{ actual: "items", each: { where: [{ actual: "price", compare: "greater-than", expected: "over" }], claims: [{ actual: "price", compare: "${compare}", expected: "bound" }] } }],
});
`;
    const rootDir = await project({
      "features/steps/every-item-costs-at-most.ts": step("every item over {over:int} costs at most {bound:int}", "at-most"),
      "features/steps/every-costly-item-costs-at-most.ts": step("every costly item over {over:int} costs at most {bound:int}", "at-most"),
      "features/steps/every-item-costs-more.ts": step("every item over {over:int} costs more than {bound:int}", "greater-than"),
      "features/t.feature": feature("Then every item over 10 costs at most 100"),
      "features/u.feature": feature("Then every costly item over 10 costs at most 100"),
      "features/v.feature": feature("Then every item over 10 costs more than 5"),
    });
    expect((await cli(rootDir, ["run", "features/t.feature"])).exitCode).toBe(0);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({ outcome: "held", each: { items: 3, selected: 2 } });
    expect((await cli(rootDir, ["run", "features/u.feature"])).exitCode).toBe(1);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({ outcome: "broken", each: { items: 3, selected: 2 } });
    expect((await cli(rootDir, ["run", "features/v.feature"])).exitCode).toBe(1);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({
      outcome: "broken",
      reason: "each.where[0] selects the items whose price is greater-than 10, and every such item holds each.claims[0], greater-than 5, whatever the data, so the claim measures nothing",
      each: { items: 3, selected: 0, results: [] },
    });
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
      `defineStep claims[0].expected is the literal ${literal}, which the word "${word}" fixes, and claims[0].compare is "${compare}". A value a word fixes is compared with equal alone, or with not-equal alone right after the word \"not\", \"neither\", or \"nor\" (\"is not empty\"): another compare against it holds for nearly anything, and the word does not show it.`,
    );
  });

  it("claims \"the cart is not empty\" with not-equal, and refuses equal against it", async () => {
    const step = (compare: string) => `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart is not empty",
  args: z.object({ cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.items", compare: "${compare}", expected: { literal: [] } }],
});
`;
    const lines = feature("When the app answers", "Then the cart is not empty");
    const held = await project({ "features/steps/the-cart-is-not-empty.ts": step("not-equal"), "features/t.feature": lines });
    expect((await cli(held, ["run", "features/t.feature"])).exitCode).toBe(0);
    expect(lastClaimStep(held).claims[0]).toMatchObject({ compare: "not-equal", expected: [], expected_from: "literal:empty", outcome: "held" });
    const refused = await project({ "features/steps/the-cart-is-not-empty.ts": step("equal"), "features/t.feature": lines });
    const checked = await cli(refused, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain(
      `defineStep claims[0].expected is the literal [], which the words "not empty" rule out, and claims[0].compare is "equal". A value a word fixes is compared with equal alone, or with not-equal alone right after the word \"not\", \"neither\", or \"nor\" (\"is not empty\"): another compare against it holds for nearly anything, and the word does not show it.`,
    );
  });
});

describe("nuka check names a claim whose two sides read one place", () => {
  it("refuses a claim whose at and from path read one value", async () => {
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
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout).toContain(
      'error\tclaim-compares-itself\tfeatures/t.feature:4\tStep "the-count-is-unchanged"\'s claims[0] reads cart of step "the-app-answers" on line 3 at count as its actual value and cart.count of step "the-app-answers" on line 3 as its expected value, one place, so it holds whatever the behaviour is\n',
    );
  });

  it("refuses an observe that receives the value an expected from reads", async () => {
    const rootDir = await project({
      "features/steps/the-cart-still-holds.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart still holds what it held",
  args: z.object({ before: answer.returns.shape.cart, now: answer.returns.shape.cart }),
  from: { before: [answer, "cart"], now: [answer, "cart"] },
  observe({}, { now }) {
    return { count: now.count };
  },
  claims: [{ actual: "count", compare: "equal", expected: { from: "before.count" } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart still holds what it held"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout).toContain(
      'error\tclaim-compares-itself\tfeatures/t.feature:4\tStep "the-cart-still-holds"\'s observe receives args.now, which is cart of step "the-app-answers" on line 3, and its claims[0].expected reads cart.count of step "the-app-answers" on line 3, so observe could return the value the claim compares it with. Take now out of this step\'s from, so observe does not receive it, or fill it from another step\n',
    );
  });

  it("breaks that claim at run time too, under --no-check and in nuka do --use, so no path holds it", async () => {
    const rootDir = await project({
      "features/steps/the-cart-still-holds.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart still holds what it held",
  args: z.object({ before: answer.returns.shape.cart, now: answer.returns.shape.cart }),
  from: { before: [answer, "cart"], now: [answer, "cart"] },
  observe({}, { now }) {
    return { count: now.count };
  },
  claims: [{ actual: "count", compare: "equal", expected: { from: "before.count" } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart still holds what it held"),
    });
    const ran = await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(ran.exitCode).toBe(1);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({
      actual: 1,
      expected: 1,
      outcome: "broken",
      reason:
        "observe received args.now, which is from:the-app-answers@3.cart, and the expected value reads from:the-app-answers@3.cart.count, so observe could return the value the claim compares it with",
    });

    const answered = await cli(rootDir, ["do", "the-app-answers", "--args", "{}"]);
    const producer = JSON.parse(answered.stdout).step_record_id as string;
    const done = await cli(rootDir, ["do", "the-cart-still-holds", "--use", producer]);
    expect(done.exitCode).toBe(1);
    const record = JSON.parse(done.stdout);
    expect(record.error.kind).toBe("claim_broken");
    expect(record.claims[0]).toMatchObject({
      outcome: "broken",
      reason: `observe received args.now, which is from:the-app-answers@${producer}.cart, and the expected value reads from:the-app-answers@${producer}.cart.count, so observe could return the value the claim compares it with`,
    });
  });

  it("breaks an each whose item claim reads, as its expected value, a value observe received", async () => {
    const rootDir = await project({
      "features/steps/every-item-is-as-before.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "every item is paid as before",
  args: z.object({ before: answer.returns.shape.cart, now: answer.returns.shape.cart }),
  from: { before: [answer, "cart"], now: [answer, "cart"] },
  observe({}, { now }) {
    return { items: [{ paid: now.items[0].paid }] };
  },
  claims: [{ actual: "items", each: { claims: [{ actual: "paid", compare: "equal", expected: { from: "before.items.0.paid" } }] } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then every item is paid as before"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.stdout).toContain("so observe could return the value the claim compares it with");
    await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({
      outcome: "broken",
      reason:
        "observe received args.now, which is from:the-app-answers@3.cart, and each.claims[0]'s expected value reads from:the-app-answers@3.cart.items.0.paid, so observe could return the value the claim compares it with",
      each: { items: 1, selected: 0, results: [] },
    });
  });

  it("judges a from actual against a value observe worked out from another key, and holds back the actual key from observe", async () => {
    const step = (read: string) => `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart count matches the body's tags",
  args: z.object({ cart: answer.returns.shape.cart, body: answer.returns.shape.body }),
  from: { cart: [answer, "cart"], body: [answer, "body"] },
  poll: false,
  observe({}, inputs) {
    return { tags: ${read} };
  },
  claims: [{ actual: "cart.count", compare: "equal", expected: { observe: "tags" } }],
});
`;
    const rootDir = await project({
      "features/steps/the-cart-count-matches.ts": step("(inputs.body as { tags: string[] }).tags.length"),
      "features/t.feature": feature("When the app answers", "Then the cart count matches the body's tags"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.stdout).toBe("ok: no issues found\n");
    expect((await cli(rootDir, ["run", "features/t.feature"])).exitCode).toBe(0);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({ actual: 1, expected: 1, outcome: "held" });
    await writeFile(path.join(rootDir, "features/steps/the-cart-count-matches.ts"), step("(inputs as Record<string, { count: number }>)[\"cart\"]!.count"));
    expect((await cli(rootDir, ["run", "features/t.feature"])).exitCode).toBe(1);
    expect(latestRunJson(rootDir).scenarios[0].steps[1]).toMatchObject({
      observation: "unobserved",
      error: {
        kind: "unobserved",
        message:
          'the step observed nothing, so no claim was judged: observe of step "the-cart-count-matches" read "cart", which a claim reads as its actual value and compares with a value observe returns. observe reads the world, and the claim compares what it read with the actual value',
      },
    });
  });

  it("refuses and breaks an observe that receives a second key holding the from value the actual reads, when the expected value comes from observe", async () => {
    const rootDir = await project({
      "features/steps/the-cart-agrees.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart agrees with the store",
  args: z.object({ cart: answer.returns.shape.cart, copy: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"], copy: [answer, "cart"] },
  poll: false,
  observe({}, inputs) {
    return { stored: inputs.copy.count };
  },
  claims: [{ actual: "cart.count", compare: "equal", expected: { observe: "stored" } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart agrees with the store"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout).toContain(
      'error\tclaim-compares-itself\tfeatures/t.feature:4\tStep "the-cart-agrees"\'s observe receives args.copy, which is cart of step "the-app-answers" on line 3, and its claims[0].actual reads cart.count of step "the-app-answers" on line 3, so observe could return the value the claim compares it with. Take copy out of this step\'s from, so observe does not receive it, or fill it from another step\n',
    );
    const ran = await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(ran.exitCode).toBe(1);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({
      actual: 1,
      expected: 1,
      outcome: "broken",
      reason:
        "observe received args.copy, which is from:the-app-answers@3.cart, and the actual value reads from:the-app-answers@3.cart.count, so observe could return the value the claim compares it with",
    });
    const answered = await cli(rootDir, ["do", "the-app-answers", "--args", "{}"]);
    const producer = JSON.parse(answered.stdout).step_record_id as string;
    const done = await cli(rootDir, ["do", "the-cart-agrees", "--use", producer]);
    expect(done.exitCode).toBe(1);
    expect(JSON.parse(done.stdout).claims[0]).toMatchObject({
      outcome: "broken",
      reason: `observe received args.copy, which is from:the-app-answers@${producer}.cart, and the actual value reads from:the-app-answers@${producer}.cart.count, so observe could return the value the claim compares it with`,
    });
  });

  it("refuses and breaks the same for an each whose item claims compare with observe, before any item", async () => {
    const rootDir = await project({
      "features/steps/every-item-agrees.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "every item agrees with the store",
  args: z.object({ cart: answer.returns.shape.cart, copy: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"], copy: [answer, "cart"] },
  poll: false,
  observe({}, inputs) {
    return { paid: inputs.copy.items[0].paid };
  },
  claims: [{ actual: "cart.items", each: { claims: [{ actual: "paid", compare: "equal", expected: { observe: "paid" } }] } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then every item agrees with the store"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.stdout).toContain(
      'Step "every-item-agrees"\'s observe receives args.copy, which is cart of step "the-app-answers" on line 3, and its claims[0].each.claims[0].actual reads paid of each item of cart.items of step "the-app-answers" on line 3, so observe could return the value the claim compares it with',
    );
    await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(lastClaimStep(rootDir).claims[0]).toMatchObject({
      outcome: "broken",
      reason:
        "observe received args.copy, which is from:the-app-answers@3.cart, and each.claims[0] reads each item of from:the-app-answers@3.cart.items, so observe could return the value the claim compares it with",
      each: { items: 2, selected: 0, results: [] },
    });
  });

  it("reports a path segment that names an Object.prototype member as unknown, and does not crash", async () => {
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
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout).toContain(
      'error\tclaim-path-unknown\tfeatures/t.feature:4\tStep "the-cart-kind-is"\'s claims[0].actual reads "cart.constructor.name", and step "the-app-answers" on line 3 returns nothing at "constructor" under cart, which has count, items. The value would be undefined, so the claim would always break\n',
    );
  });

  it("names the top of the result for a dotted from key, and says a from key reads one level", async () => {
    const rootDir = await project({
      "features/steps/the-count-is.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the count is {count:int}",
  args: z.object({ count: z.number(), total: z.number() }),
  from: { total: [answer, "cart.count"] },
  claims: [{ actual: "total", compare: "equal", expected: "count" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the count is 1"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout).toContain(
      'error\tfrom-structural-violation\tfeatures/steps/the-count-is.ts\tfrom.total names key "cart.count", which is not one of the upstream step\'s returns keys\n' +
        '  fix: Name a key that the upstream step\'s returns declares. The upstream step\'s returns declares cart, out, body. A from key reads one level of the result, so name "cart" in from and read count under it in the path that uses it.\n',
    );
    expect(checked.stdout).toContain(
      'error\tclaim-path-unknown\tfeatures/t.feature:4\tStep "the-count-is"\'s claims[0].actual reads "total", and step "the-app-answers" on line 3 returns nothing at "cart.count" at the top of its result, which has cart, out, body. "cart.count" is one key, not a path: a from key reads one level of the result. The value would be undefined, so the claim would always break\n',
    );
  });

  it("refuses an expected key a parameter type with a transformer fills", async () => {
    const rootDir = await project({
      "nukadoko.config.ts":
        'import { defineConfig } from "nukadoko";\nexport default defineConfig({ parameterTypes: [{ name: "money", regexp: /\\d+/, transformer: () => 0 }] });\n',
      "features/steps/it-costs.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "it costs {price:money}",
  args: z.object({ price: z.number(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.count", compare: "equal", expected: "price" }],
});
`,
      "features/t.feature": feature("When the app answers", "Then it costs 5"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout).toContain(
      'error\tclaim-expected-transformed\tfeatures/steps/it-costs.ts\tStep "it-costs"\'s claims[0].expected is args.price, and its pattern "it costs {price:money}" fills it with the parameter type {money}, whose transformer rewrites the line\'s text before the claim reads it, so code would decide what the claim compares. Capture price with a type that has no transformer, such as {price:string}, and read it with expected_view if it needs one\n',
    );
  });

  it("leaves that claim unjudged under --no-check, in the check's words, and judges the step's other claims", async () => {
    const rootDir = await project({
      "nukadoko.config.ts":
        'import { defineConfig } from "nukadoko";\nexport default defineConfig({ parameterTypes: [{ name: "money", regexp: /\\d+/, transformer: () => 1 }] });\n',
      "features/steps/it-costs.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "it costs {price:money} for {count:int} items",
  args: z.object({ price: z.number(), count: z.number(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [
    { actual: "cart.count", compare: "equal", expected: "price" },
    { actual: "cart.count", compare: "equal", expected: "count" },
    { actual: "cart.items", each: { claims: [{ actual: "title", compare: "not-equal", expected: "price" }] } },
  ],
});
`,
      "features/t.feature": feature("When the app answers", "Then it costs 5 for 1 items"),
    });
    const refused = await cli(rootDir, ["run", "features/t.feature"]);
    expect(refused.exitCode).not.toBe(0);
    const ran = await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(ran.exitCode).toBe(1);
    const step = lastClaimStep(rootDir);
    const reason =
      'the pattern "it costs {price:money} for {count:int} items" fills args.price with the parameter type {money}, whose transformer rewrites the line\'s text before the claim reads it, so code would decide what the claim compares, and the claim was not judged';
    expect(step.error.kind).toBe("claim_unjudged");
    expect(step.claims[0]).toMatchObject({ actual: 1, expected_from: "sentence:price", outcome: "unjudged", reason });
    expect(step.claims[0]).not.toHaveProperty("expected");
    expect(step.claims[1]).toMatchObject({ actual: 1, expected: 1, outcome: "held" });
    expect(step.claims[2]).toMatchObject({ outcome: "unjudged", reason: `each.claims[0]: ${reason}`, each: { items: 2, selected: 0, results: [] } });
  });
});

describe("a claim step with no observe judges every value its line states", () => {
  it("refuses at defineStep a pattern capture no claim reads, and accepts it once observe receives it", async () => {
    const rootDir = await project({
      "features/steps/the-cart-is-not-empty-for.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart is not empty for {name:string}",
  args: z.object({ name: z.string(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.items", compare: "not-equal", expected: { literal: [] } }],
});
`,
      "features/steps/the-list-of-is-not-empty.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the list of {name:string} is not empty",
  args: z.object({ name: z.string() }),
  observe({}, { name }) { return { items: [name] }; },
  claims: [{ actual: "items", compare: "not-equal", expected: { literal: [] } }],
});
`,
      "features/t.feature": feature("When the app answers", 'Then the cart is not empty for "alice"'),
      "features/u.feature": feature('Then the list of "alice" is not empty'),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain(
      'defineStep the pattern captures "name", and no claim reads it, and the step has no observe to receive it, so nothing checks the value the line states. Compare a claim with "name", or take it out of the pattern.',
    );
    await rm(path.join(rootDir, "features/steps/the-cart-is-not-empty-for.ts"));
    expect((await cli(rootDir, ["run", "features/u.feature"])).exitCode).toBe(0);
  });

  it("reports a docstring no claim reads (claim-sentence-unread), and the run breaks the claims with the same reason", async () => {
    const rootDir = await project({
      "features/steps/the-cart-is-not-empty.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart is not empty",
  args: z.object({ note: z.string(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.items", compare: "not-equal", expected: { literal: [] } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart is not empty", '  """', "  for alice", '  """'),
    });
    const reason = "the docstring of the line fills args.note, which no claim reads, and the step has no observe to receive it, so nothing checks the value the line states";
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout).toContain(`claim-sentence-unread`);
    expect(checked.stdout).toContain(`Step "the-cart-is-not-empty": ${reason}. Compare a claim with "note", or take the docstring off the line`);
    const ran = await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(ran.exitCode).toBe(1);
    const step = lastClaimStep(rootDir);
    expect(step.error.kind).toBe("claim_broken");
    expect(step.observation).toBe("unobserved");
    expect(step.attempts).toBe(0);
    expect(step.claims[0]).toMatchObject({ outcome: "broken", reason });
  });
});

describe("observe reads the world, never an earlier step's result", () => {
  it("throws on resultOf inside observe, so the step observed nothing", async () => {
    const rootDir = await project({
      "features/steps/the-cart-still-holds.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart still holds what it held",
  args: z.object({ before: answer.returns.shape.cart }),
  from: { before: [answer, "cart"] },
  observe({ resultOf }) {
    return { count: resultOf(answer)!.cart.count };
  },
  claims: [{ actual: "count", compare: "equal", expected: { from: "before.count" } }],
});
`,
      "features/t.feature": feature("When the app answers", "Then the cart still holds what it held"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const step = lastClaimStep(rootDir);
    expect(step.error).toEqual({
      kind: "unobserved",
      message:
        'the step observed nothing, so no claim was judged: resultOf is not available to step "the-cart-still-holds", a claim step: observe reads the world, and a value from an earlier step reaches a claim step only through from, where the record names its origin. Declare the value in the step\'s from instead',
    });
    expect(step.claims[0].outcome).toBe("unobserved");
  });
});

describe("run.json and the summary say what judged each scenario", () => {
  function compatThen(rootDir: string): string {
    const compat = path.relative(path.join(rootDir, "features", "steps"), path.join(repoRoot, "src", "compat", "index.js")).split(path.sep).join("/");
    return `import { Then } from "${compat}";\nThen("the receipt is correct", function () {});\n`;
  }

  it("counts held and broken claims, names a scenario judged by compat or by nothing, and says a check was skipped", async () => {
    // "claim off Then" binds a claim step on a When line, which nuka check
    // refuses (claims-outside-then); under --no-check it runs, and its
    // claim is counted, but no Then judged the scenario. "unbound Then"
    // has a Then line no step matches, and "skipped Then" a claim step
    // that never ran: no claim on a Then line was judged in either.
    const rootDir = await project({
      "features/steps/it-counts.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "it counts {code:int}",
  args: z.object({ code: z.number(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  claims: [{ actual: "cart.count", compare: "equal", expected: "code" }],
});
`,
      "features/t.feature": [
        "Feature: judged",
        "  Scenario: claims",
        "    When the app answers",
        "    Then it counts 1",
        "    And it counts 2",
        "  Scenario: compat",
        "    When the app answers",
        "    Then the receipt is correct",
        "  Scenario: nothing",
        "    When the app answers",
        "  Scenario: claim off Then",
        "    When the app answers",
        "    And it counts 1",
        "  Scenario: unbound Then",
        "    When the app answers",
        "    Then no step matches this line",
        "  Scenario: skipped Then",
        "    When no step matches this line",
        "    Then it counts 1",
        "",
      ].join("\n"),
    });
    await writeFile(path.join(rootDir, "features", "steps", "receipt.ts"), compatThen(rootDir));
    await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    const run = latestRunJson(rootDir);
    expect(run.check).toBe("skipped");
    expect(run.scenarios.map((scenario: Record<string, unknown>) => [scenario.scenario, scenario.claims, scenario.judged_by])).toEqual([
      ["claims", { held: 1, broken: 1 }, undefined],
      ["compat", { held: 0, broken: 0 }, "compat"],
      ["nothing", { held: 0, broken: 0 }, "nothing"],
      ["claim off Then", { held: 1, broken: 0 }, "nothing"],
      ["unbound Then", { held: 0, broken: 0 }, "nothing"],
      ["skipped Then", { held: 0, broken: 0 }, "nothing"],
    ]);
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain("- check: skipped (`nuka run --no-check`), so no finding of `nuka check` held this run back\n");
    expect(summary).toContain(
      [
        "## Scenarios with no claim",
        "",
        "In each scenario below, no claim on a Then line was judged (held, broken, or unjudged).",
        "",
        "- `features/t.feature:6` compat: no claim judged it, and a compat step in Then position may have, by throwing or not, where nukadoko cannot see what it checked",
        "- `features/t.feature:9` nothing: no claim on a Then line was judged in it",
        "- `features/t.feature:11` claim off Then: no claim on a Then line was judged in it",
        "- `features/t.feature:14` unbound Then: no claim on a Then line was judged in it",
        "- `features/t.feature:17` skipped Then: no claim on a Then line was judged in it",
      ].join("\n"),
    );

    await cli(rootDir, ["run", "features/t.feature:2"]);
    expect(latestRunJson(rootDir).check).toBe("ran");
    expect(await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8")).not.toContain("- check:");
  });
});

describe("measured names the channel that holds a claim's actual value", () => {
  it("names a process exit code, and says measured: none for a constant", async () => {
    const rootDir = await project({
      "features/steps/the-app-exits.ts": `import { defineStep, runCommand, z } from "nukadoko";
export default defineStep({
  description: "Run a program that exits 3",
  pattern: "the program runs",
  args: z.object({}),
  returns: z.object({ exitCode: z.number().nullable() }),
  mutates: false,
  async run() {
    const result = await runCommand(process.execPath, ["-e", "process.exit(3)"]);
    return { exitCode: result.exitCode };
  },
});
`,
      "features/steps/it-exits-with.ts": `import { defineStep, z } from "nukadoko";
import program from "./the-app-exits.ts";
export default defineStep({
  pattern: "it exits with {code:int}",
  args: z.object({ code: z.number(), exitCode: z.number().nullable() }),
  from: { exitCode: [program, "exitCode"] },
  claims: [{ actual: "exitCode", compare: "equal", expected: "code" }],
});
`,
      "features/steps/the-total-is.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the total is {total:string}",
  args: z.object({ total: z.string() }),
  observe() {
    return { shown: "42" };
  },
  claims: [{ actual: "shown", compare: "equal", expected: "total" }],
});
`,
      "features/t.feature": feature("When the program runs", "Then it exits with 3", 'And the total is "42"'),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(0);
    const run = latestRunJson(rootDir);
    const [producer, exits] = run.scenarios[0].steps;
    expect(exits.claims[0].measured).toEqual({ step_record_id: producer.step_record_id, channel: "observed.processes[0].exit_code" });
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain(`  - 3 (from:the-app-exits@3.exitCode) equal 3 (sentence:code) held; measured: observed.processes[0].exit_code of ${producer.step_record_id}\n`);
    expect(summary).toContain('  - "42" (observe:shown) equal "42" (sentence:total) held; measured: none\n');
  });

  it("says expected measured: none for a constant the When step returned, and names the channel of one it measured", async () => {
    const rootDir = await project({
      "features/steps/the-command-runs.ts": `import { defineStep, runCommand, z } from "nukadoko";
export default defineStep({
  description: "Run a program that prints v1 and exits 0",
  pattern: "the command runs",
  args: z.object({}),
  returns: z.object({ exitCode: z.number(), wanted: z.number(), version: z.string() }),
  mutates: false,
  async run() {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('v1')"]);
    return { exitCode: result.exitCode ?? -1, wanted: 0, version: result.stdout };
  },
});
`,
      "features/steps/the-command-succeeds.ts": `import { defineStep, z } from "nukadoko";
import command from "./the-command-runs.ts";
export default defineStep({
  pattern: "the command succeeds",
  args: z.object({ exitCode: command.returns.shape.exitCode, wanted: command.returns.shape.wanted }),
  from: { exitCode: [command, "exitCode"], wanted: [command, "wanted"] },
  claims: [{ actual: "exitCode", compare: "equal", expected: { from: "wanted" } }],
});
`,
      "features/steps/the-tool-reports-that-version.ts": `import { defineStep, runCommand, z } from "nukadoko";
import command from "./the-command-runs.ts";
export default defineStep({
  pattern: "the tool reports that version",
  args: z.object({ version: command.returns.shape.version }),
  from: { version: [command, "version"] },
  async observe() {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('v1')"]);
    return { shown: result.stdout };
  },
  claims: [{ actual: "shown", compare: "equal", expected: { from: "version" } }],
});
`,
      "features/t.feature": feature("When the command runs", "Then the command succeeds", "And the tool reports that version"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(0);
    const run = latestRunJson(rootDir);
    const [producer, succeeds, reports] = run.scenarios[0].steps;
    expect(succeeds.claims[0].measured).toEqual({ step_record_id: producer.step_record_id, channel: "observed.processes[0].exit_code" });
    expect(succeeds.claims[0].expected_measured).toBeNull();
    expect(reports.claims[0].expected_measured).toEqual({ step_record_id: producer.step_record_id, channel: "observed.processes[0].stdout" });
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain(
      `  - 0 (from:the-command-runs@3.exitCode) equal 0 (from:the-command-runs@3.wanted) held; measured: observed.processes[0].exit_code of ${producer.step_record_id}; expected measured: none\n`,
    );
    expect(summary).toContain(
      `  - "v1" (observe:shown) equal "v1" (from:the-command-runs@3.version) held; measured: observed.processes[0].stdout; expected measured: observed.processes[0].stdout of ${producer.step_record_id}\n`,
    );
  });
});

describe("a polled claim step records what each reading read", () => {
  it("keeps every reading's values, so a value that walks to the expected one is visible", async () => {
    const rootDir = await project({
      "features/steps/the-counter-shows.ts": `import { defineStep, z } from "nukadoko";
let calls = 0;
export default defineStep({
  pattern: "the counter shows {n:int}",
  args: z.object({ n: z.number() }),
  poll: { timeout_ms: 10000 },
  observe() {
    const candidate = Math.floor(calls / 2);
    calls += 1;
    return { count: candidate };
  },
  claims: [{ actual: "count", compare: "equal", expected: "n" }],
});
`,
      "features/t.feature": feature("Then the counter shows 3"),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const step = lastClaimStep(rootDir);
    expect(step.attempts).toBe(8);
    const record = JSON.parse(await readFile(path.join(latestRunDir(rootDir), step.record, "record.json"), "utf8")) as { readings: Record<string, unknown>[] };
    expect(record.readings.map((reading) => [reading.attempt, reading.held, reading.actuals])).toEqual([
      [1, false, [{ value: 0 }]],
      [2, false, [{ value: 0 }]],
      [3, false, [{ value: 1 }]],
      [4, false, [{ value: 1 }]],
      [5, false, [{ value: 2 }]],
      [6, false, [{ value: 2 }]],
      [7, true, [{ value: 3 }]],
      [8, true, [{ value: 3 }]],
    ]);
    for (const reading of record.readings) expect(typeof reading.at).toBe("string");
  });
});

describe("a polled claim step whose expected value comes from observe records both sides", () => {
  it("keeps each reading's expected value, so an expected value that walks to a constant actual one is visible", async () => {
    const rootDir = await project({
      "features/steps/the-badge-agrees.ts": `import { defineStep, z } from "nukadoko";
let calls = 0;
export default defineStep({
  pattern: "the badge agrees with the counter",
  args: z.object({}),
  poll: { timeout_ms: 10000 },
  observe() {
    const counter = Math.min(calls, 3);
    calls += 1;
    return { badge: 3, counter };
  },
  claims: [{ actual: "badge", compare: "equal", expected: { observe: "counter" } }],
});
`,
      "features/t.feature": feature("Then the badge agrees with the counter"),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const step = lastClaimStep(rootDir);
    const record = JSON.parse(await readFile(path.join(latestRunDir(rootDir), step.record, "record.json"), "utf8")) as { readings: Record<string, unknown>[] };
    expect(record.readings.map((reading) => [reading.attempt, reading.held, reading.actuals, reading.expecteds])).toEqual([
      [1, false, [{ value: 3 }], [{ value: 0 }]],
      [2, false, [{ value: 3 }], [{ value: 1 }]],
      [3, false, [{ value: 3 }], [{ value: 2 }]],
      [4, true, [{ value: 3 }], [{ value: 3 }]],
      [5, true, [{ value: 3 }], [{ value: 3 }]],
    ]);
  });
});

describe("a long poll keeps the readings where the value changed", () => {
  it("keeps every candidate a padded observe offered, and says how many readings it left out", async () => {
    const rootDir = await project({
      "features/steps/the-list-includes.ts": `import { defineStep, z } from "nukadoko";
const plan: string[] = Array(10).fill("x");
for (const candidate of ["y", "z"]) plan.push(candidate, candidate, ...Array(18).fill("x"));
plan.push("milk");
let calls = 0;
export default defineStep({
  pattern: "the list includes {name:string}",
  args: z.object({ name: z.string() }),
  poll: { timeout_ms: 20000 },
  observe() {
    const shown = plan[Math.min(calls, plan.length - 1)]!;
    calls += 1;
    return { list: [shown] };
  },
  claims: [{ actual: "list", compare: "has-item", expected: "name" }],
});
`,
      "features/t.feature": feature('Then the list includes "milk"'),
    });
    await cli(rootDir, ["run", "features/t.feature"]);
    const step = lastClaimStep(rootDir);
    expect(step.attempts).toBe(52);
    const record = JSON.parse(await readFile(path.join(latestRunDir(rootDir), step.record, "record.json"), "utf8")) as {
      readings: { attempt: number; actuals: { value: string[] }[] }[];
      readings_left_out: unknown;
    };
    expect(record.readings.map((reading) => [reading.attempt, reading.actuals[0]!.value[0]])).toEqual([
      [1, "x"],
      [11, "y"],
      [13, "x"],
      [31, "z"],
      [33, "x"],
      [51, "milk"],
      [52, "milk"],
    ]);
    expect(record.readings_left_out).toEqual({ readings: 45, change_points: 0 });
  });
});

describe("measured names an HTTP status", () => {
  it("names the status of the response the producing step received", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"id":1}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const rootDir = await project({
        "nukadoko.program.ts": `import { defineProgram } from "nukadoko";\nexport default defineProgram({ url: "http://127.0.0.1:${port}" });\n`,
        "features/steps/an-item-is-created.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  description: "POST /items",
  pattern: "an item is created",
  args: z.object({}),
  returns: z.object({ status: z.number() }),
  mutates: true,
  async run({ request }) {
    const response = await request.post("/items", { data: {} });
    return { status: response.status() };
  },
});
`,
        "features/steps/the-status-is.ts": `import { defineStep, z } from "nukadoko";
import created from "./an-item-is-created.ts";
export default defineStep({
  pattern: "the status is {code:int}",
  args: z.object({ code: z.number(), status: z.number() }),
  from: { status: [created, "status"] },
  claims: [{ actual: "status", compare: "equal", expected: "code" }],
});
`,
        "features/t.feature": feature("When an item is created", "Then the status is 201"),
      });
      const result = await cli(rootDir, ["run", "features/t.feature"]);
      expect(result.exitCode).toBe(0);
      const [producer, status] = latestRunJson(rootDir).scenarios[0].steps;
      expect(status.claims[0].measured).toEqual({ step_record_id: producer.step_record_id, channel: "http.jsonl[0].status" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the compares a sentence states a part of a value with, through a run", () => {
  /** Runs one claim step against two scenarios, the first holding and
   * the second broken, and gives the exit code and the claim lines under
   * the summary's Claims. */
  async function holdsThenBreaks(step: string, held: readonly string[], broken: readonly string[]) {
    const scenario = (name: string, lines: readonly string[]) => [`  Scenario: ${name}`, ...lines.map((line) => `    ${line}`)];
    const rootDir = await project({
      "features/steps/claim.ts": step,
      "features/t.feature": ["Feature: compares", ...scenario("holds", held), ...scenario("breaks", broken), ""].join("\n"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    return { exitCode: result.exitCode, claimLines: summary.split("\n").filter((line) => line.startsWith("  - ") && line.includes("; measured: ")) };
  }

  it("has-fields holds for the fields a docstring states of a larger response, and names the first field that does not fit", async () => {
    const run = await holdsThenBreaks(
      `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the order reads",
  args: z.object({ fields: z.string() }),
  observe() {
    return { body: { id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", status: "paid", total: 12, lines: [{ sku: "a", qty: 1 }], owner: { name: "aki" } } };
  },
  claims: [{ actual: "body", compare: "has-fields", expected: "fields", expected_view: "json" }],
});
`,
      ["Then the order reads", '  """', '  { "status": "paid", "lines": [{ "sku": "a" }] }', '  """'],
      ["Then the order reads", '  """', '  { "status": "paid", "owner": { "name": "kei" } }', '  """'],
    );
    expect(run.exitCode).toBe(1);
    expect(run.claimLines).toEqual([
      expect.stringMatching(/ has-fields \{"status":"paid","lines":\[\{"sku":"a"\}\]\} \(sentence:fields as json\) held; measured: none$/),
      expect.stringMatching(/ has-fields \{"status":"paid","owner":\{"name":"kei"\}\} \(sentence:fields as json\) broken; first field that does not fit at owner\.name: actual "aki", expected "kei"; measured: none$/),
    ]);
  });

  it("fits-text holds for output whose times change when the docstring stands in for them, and names where a line stopped fitting", async () => {
    const run = await holdsThenBreaks(
      `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the build prints",
  args: z.object({ expected: z.string() }),
  observe() {
    return { out: "built 3 files in " + (40 + (Date.now() % 7)) + "ms\\nwrote dist/a.js\\nwrote dist/b.js\\ndone\\n" };
  },
  claims: [{ actual: "out", compare: "fits-text", expected: "expected" }],
});
`,
      ["Then the build prints", '  """', "  built [..] files in [..]ms", "  ...", "  done", '  """'],
      ["Then the build prints", '  """', "  built [..] files in [..]ms", "  ...", "  wrote dist/c.js", "  done", '  """'],
    );
    expect(run.exitCode).toBe(1);
    expect(run.claimLines).toEqual([
      expect.stringMatching(/ fits-text "built \[\.\.\] files in \[\.\.\]ms\\+n\.\.\.\\+ndone" \(sentence:expected\) held; measured: none$/),
      expect.stringMatching(
        / \(sentence:expected\) broken; expected lines 1 to 2 fit, and expected line 3 fits nothing from actual line 2: actual "wrote dist\/a\.js", expected "wrote dist\/c\.js"; measured: none$/,
      ),
    ]);
  });
});

describe("is-a through a run", () => {
  it("holds for a generated id the sentence names as a UUID, by a fixed word or a capture, and breaks for a total named as a text", async () => {
    const order = `observe() {
    return { order: { id: "0190A1B2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", total: 12 } };
  },`;
    const rootDir = await project({
      "features/steps/the-order-id-is-a-uuid.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the order id is a UUID",
  args: z.object({}),
  ${order}
  claims: [{ actual: "order.id", compare: "is-a", expected: { literal: "UUID" } }],
});
`,
      "features/steps/the-order-total-is-a.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the order total is a {kind:word}",
  args: z.object({ kind: z.string() }),
  ${order}
  claims: [{ actual: "order.total", compare: "is-a", expected: "kind" }],
});
`,
      "features/t.feature": [
        "Feature: kinds",
        "  Scenario: holds",
        "    Then the order id is a UUID",
        "    Then the order total is a number",
        "  Scenario: breaks",
        "    Then the order total is a text",
        "",
      ].join("\n"),
    });
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary.split("\n").filter((line) => line.startsWith("  - ") && line.includes("; measured: "))).toEqual([
      '  - "0190A1B2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" (observe:order.id) is-a "UUID" (literal:UUID) held; measured: none',
      '  - 12 (observe:order.total) is-a "number" (sentence:kind) held; measured: none',
      '  - 12 (observe:order.total) is-a "text" (sentence:kind) broken; measured: none',
    ]);
  });
  it("reports in nuka check a line whose capture names no kind, and none whose capture names one", async () => {
    const rootDir = await project({
      "features/steps/the-order-total-is-a.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the order total is a {kind:word}",
  args: z.object({ kind: z.string() }),
  observe() {
    return { order: { total: 12 } };
  },
  claims: [{ actual: "order.total", compare: "is-a", expected: "kind" }],
});
`,
      "features/steps/the-order-id-is.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  pattern: "the order id is {kind:string}",
  args: z.object({ kind: z.string() }),
  observe() {
    return { order: { id: "x" } };
  },
  claims: [{ actual: "order", each: { claims: [{ actual: "id", compare: "is-a", expected: "kind", expected_view: "text" }] } }],
});
`,
      "features/t.feature": [
        "Feature: kinds",
        "  Scenario: named",
        "    Then the order total is a number",
        '    Then the order id is " UUID "',
        "  Scenario: unnamed",
        "    Then the order total is a snowflake",
        '    Then the order id is "guid"',
        "",
      ].join("\n"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    const kinds = "string, text, number, integer, boolean, list, array, object, null, uuid, date, timestamp, url";
    expect(checked.stdout.split("\n").filter((line) => line.includes("claim-kind-unknown"))).toEqual([
      `error\tclaim-kind-unknown\tfeatures/t.feature:6\tStep "the-order-total-is-a"'s claims[0].expected is args.kind, which this line fills with "snowflake", and is-a names one of the kinds ${kinds}, so the claim would always break`,
      `error\tclaim-kind-unknown\tfeatures/t.feature:7\tStep "the-order-id-is"'s claims[0].each.claims[0].expected is args.kind, which this line fills with "guid", and is-a names one of the kinds ${kinds}, so the claim would always break`,
    ]);
  });
});

describe("count through a run", () => {
  /** A claim step that reads one key of the step that answers. */
  const step = (pattern: string, key: string, args: string, claim: string) => `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "${pattern}",
  args: z.object({ ${args}${args === "" ? "" : ", "}${key}: answer.returns.shape.${key} }),
  from: { ${key}: [answer, "${key}"] },
  claims: [${claim}],
});
`;

  it("counts a list a step returned, read at a path or as lines, by a capture or a number word, and breaks on a text, naming what it counted", async () => {
    const rootDir = await project({
      "features/steps/the-cart-holds-items.ts": step("the cart holds {n:int} items", "cart", "n: z.number()", `{ actual: "cart", at: "items", count: true, compare: "equal", expected: "n" }`),
      "features/steps/the-cart-holds-one.ts": step("the cart holds at least one item", "cart", "", `{ actual: "cart", at: "items", count: true, compare: "at-least", expected: { literal: 1 } }`),
      "features/steps/the-output-has-lines.ts": step("the output has {n:int} line", "out", "n: z.number()", `{ actual: "out", view: "lines", count: true, compare: "equal", expected: "n" }`),
      "features/steps/no-tag-is-left.ts": step("no tag is left", "body", "", `{ actual: "body", at: "tags", count: true, compare: "equal", expected: { literal: 0 } }`),
      "features/steps/the-output-holds-items.ts": step("the output holds {n:int} items", "out", "n: z.number()", `{ actual: "out", count: true, compare: "equal", expected: "n" }`),
      "features/t.feature": [
        "Feature: counts",
        "  Scenario: holds",
        "    When the app answers",
        "    Then the cart holds 2 items",
        "    Then the cart holds at least one item",
        "    Then the output has 1 line",
        "  Scenario: breaks",
        "    When the app answers",
        "    Then no tag is left",
        "  Scenario: not a list",
        "    When the app answers",
        "    Then the output holds 3 items",
        "",
      ].join("\n"),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.stdout).not.toContain("error\t");
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary.split("\n").filter((line) => line.startsWith("  - ") && line.includes("; measured: "))).toEqual([
      "  - 2 (count of from:the-app-answers@3.cart.items) equal 2 (sentence:n) held; measured: none",
      "  - 2 (count of from:the-app-answers@3.cart.items) at-least 1 (literal:one) held; measured: none",
      "  - 1 (count of from:the-app-answers@3.out as lines) equal 1 (sentence:n) held; measured: none",
      "  - 1 (count of from:the-app-answers@8.body.tags) equal 0 (literal:no) broken; measured: none",
      "  - count of from:the-app-answers@11.out equal 3 (sentence:n) broken: count reads an array, and the value is a string; measured: none",
    ]);
    const claim = latestRunJson(rootDir).scenarios[0].steps[1].claims[0];
    expect(claim).toMatchObject({ actual: 2, actual_from: "count of from:the-app-answers@3.cart.items", at: "items", count: true, outcome: "held" });
  });
});

describe("an absent field through a run", () => {
  it("tells a field the response leaves out from one it sets to null, names the field and its value when it is there, and breaks when the parent is missing", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/users/2" ? '{"id":2,"name":"kei","password":null}' : '{"id":1,"name":"aki"}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const claimStep = (pattern: string, args: string, claim: string) => `import { defineStep, z } from "nukadoko";
import fetched from "./user-is-fetched.ts";
export default defineStep({
  pattern: "${pattern}",
  args: z.object({ ${args}${args === "" ? "" : ", "}body: fetched.returns.shape.body }),
  from: { body: [fetched, "body"] },
  claims: [${claim}],
});
`;
      const rootDir = await project({
        "nukadoko.program.ts": `import { defineProgram } from "nukadoko";\nexport default defineProgram({ url: "http://127.0.0.1:${port}" });\n`,
        "features/steps/user-is-fetched.ts": `import { defineStep, z } from "nukadoko";
export default defineStep({
  description: "GET /users/<id>",
  pattern: "user {id:int} is fetched",
  args: z.object({ id: z.number() }),
  returns: z.object({ body: z.unknown() }),
  mutates: false,
  async run({ request }, { id }) {
    const response = await request.get(\`/users/\${id}\`);
    return { body: await response.json() };
  },
});
`,
        "features/steps/the-user-has-no-password-field.ts": claimStep("the user has no password field", "", `{ actual: "body", compare: "lacks-field", expected: { literal: "password" } }`),
        "features/steps/the-user-carries-no-field.ts": claimStep("the user carries no {field:word} field", "field: z.string()", `{ actual: "body", compare: "lacks-field", expected: "field" }`),
        "features/steps/the-profile-has-no-password-field.ts": claimStep("the profile has no password field", "", `{ actual: "body.profile", compare: "lacks-field", expected: { literal: "password" } }`),
        "features/t.feature": [
          "Feature: absent fields",
          "  Scenario: left out",
          "    When user 1 is fetched",
          "    Then the user has no password field",
          "    Then the user carries no token field",
          "  Scenario: set to null",
          "    When user 2 is fetched",
          "    Then the user has no password field",
          "  Scenario: named",
          "    When user 2 is fetched",
          "    Then the user carries no name field",
          "  Scenario: no profile",
          "    When user 1 is fetched",
          "    Then the profile has no password field",
          "",
        ].join("\n"),
      });
      const checked = await cli(rootDir, ["check", "features/t.feature"]);
      expect(checked.stdout).not.toContain("error\t");
      const result = await cli(rootDir, ["run", "features/t.feature"]);
      expect(result.exitCode).toBe(1);
      const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
      const lines = summary.split("\n").filter((line) => line.startsWith("  - ") && line.includes("; measured: "));
      expect(lines.map((line) => line.replace(/ of step-[0-9a-z-]+$/, " of <the fetch>"))).toEqual([
        `  - {"id":1,"name":"aki"} (from:user-is-fetched@3.body) lacks-field "password" (literal:password) held; measured: http.jsonl[0].response_body of <the fetch>`,
        `  - {"id":1,"name":"aki"} (from:user-is-fetched@3.body) lacks-field "token" (sentence:field) held; measured: http.jsonl[0].response_body of <the fetch>`,
        `  - {"id":2,"name":"kei","password":null} (from:user-is-fetched@7.body) lacks-field "password" (literal:password) broken; field "password" is present and holds null; measured: http.jsonl[0].response_body of <the fetch>`,
        `  - {"id":2,"name":"kei","password":null} (from:user-is-fetched@10.body) lacks-field "name" (sentence:field) broken; field "name" is present and holds "kei"; measured: http.jsonl[0].response_body of <the fetch>`,
        "  - from:user-is-fetched@13.body.profile lacks-field \"password\" (literal:password) broken: from:user-is-fetched@13.body.profile is undefined; measured: none",
      ]);
      const [fetch, lacks] = latestRunJson(rootDir).scenarios[1].steps;
      expect(lacks.claims[0]).toMatchObject({ actual: { id: 2, name: "kei", password: null }, compare: "lacks-field", expected: "password", outcome: "broken" });
      expect(lacks.claims[0].measured).toEqual({ step_record_id: fetch.step_record_id, channel: "http.jsonl[0].response_body" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("a field the producer's returns never keeps", () => {
  /** A step that signs a user up and returns the user with a password,
   * through `user` in the returns schema the test names. */
  const signUp = (user: string, users: string) => `import { defineStep, z } from "nukadoko";
export default defineStep({
  description: "Signs a user up",
  pattern: "a user signs up",
  args: z.object({}),
  returns: z.object({ user: ${user}, users: z.array(${users}) }),
  mutates: false,
  run() {
    const user = { name: "aki", password: "secret" };
    return { user, users: [user] };
  },
});
`;
  const claimStep = (pattern: string, args: string, claims: string) => `import { defineStep, z } from "nukadoko";
import signUp from "./a-user-signs-up.ts";
export default defineStep({
  pattern: "${pattern}",
  args: z.object({ ${args}${args === "" ? "" : ", "}user: signUp.returns.shape.user, users: signUp.returns.shape.users }),
  from: { user: [signUp, "user"], users: [signUp, "users"] },
  claims: [${claims}],
});
`;
  const steps = {
    "features/steps/the-user-has-no-password-field.ts": claimStep("the user has no password field", "", `{ actual: "user", compare: "lacks-field", expected: { literal: "password" } }`),
    "features/steps/the-user-carries-no-field.ts": claimStep("the user carries no {field:word} field", "field: z.string()", `{ actual: "user", compare: "lacks-field", expected: "field" }`),
    "features/steps/every-user-without-a-deleted-at-field-has-no-password-field.ts": claimStep(
      "every user without a deleted_at field has no password field",
      "",
      `{ actual: "users", each: { where: [{ compare: "lacks-field", expected: { literal: "deleted_at" } }], claims: [{ compare: "lacks-field", expected: { literal: "password" } }] } }`,
    ),
  };
  const feature = [
    "Feature: sign up",
    "  Scenario: a literal",
    "    When a user signs up",
    "    Then the user has no password field",
    "  Scenario: a capture",
    "    When a user signs up",
    "    Then the user carries no password field",
    "    Then the user carries no name field",
    "  Scenario: each user",
    "    When a user signs up",
    "    Then every user without a deleted_at field has no password field",
    "",
  ].join("\n");

  it("is reported by nuka check for a z.object or a z.strictObject that does not declare it, on a claim and on a where clause, and the run refuses to start", async () => {
    for (const object of ["z.object", "z.strictObject"]) {
      const rootDir = await project({ "features/steps/a-user-signs-up.ts": signUp(`${object}({ name: z.string() })`, `${object}({ name: z.string() })`), ...steps, "features/t.feature": feature });
      const checked = await cli(rootDir, ["check", "features/t.feature"]);
      const findings = checked.stdout.split("\n").filter((line) => line.startsWith("error\tclaim-field-stripped\t"));
      expect(findings).toEqual([
        'error\tclaim-field-stripped\tfeatures/t.feature:4\tStep "the-user-has-no-password-field"\'s claims[0] is lacks-field "password" on user, and step "a-user-signs-up" on line 3 returns that value through an object schema that declares name, which drops any key it does not declare, or refuses it as a strict object. password is never there, so the claim never breaks, whatever the behaviour is',
        'error\tclaim-field-stripped\tfeatures/t.feature:7\tStep "the-user-carries-no-field"\'s claims[0] is lacks-field "password" on user, and step "a-user-signs-up" on line 6 returns that value through an object schema that declares name, which drops any key it does not declare, or refuses it as a strict object. password is never there, so the claim never breaks, whatever the behaviour is',
        'error\tclaim-field-stripped\tfeatures/t.feature:11\tStep "every-user-without-a-deleted-at-field-has-no-password-field"\'s claims[0].each.where[0] is lacks-field "deleted_at" on each item of users, and step "a-user-signs-up" on line 10 returns that value through an object schema that declares name, which drops any key it does not declare, or refuses it as a strict object. deleted_at is never there, so where never leaves an item out, whatever the behaviour is',
        'error\tclaim-field-stripped\tfeatures/t.feature:11\tStep "every-user-without-a-deleted-at-field-has-no-password-field"\'s claims[0].each.claims[0] is lacks-field "password" on each item of users, and step "a-user-signs-up" on line 10 returns that value through an object schema that declares name, which drops any key it does not declare, or refuses it as a strict object. password is never there, so the claim never breaks, whatever the behaviour is',
      ]);
      expect(checked.exitCode).toBe(1);
      const result = await cli(rootDir, ["run", "features/t.feature"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("claim-field-stripped");
    }
  });

  it("is not reported for a schema that keeps the field, and the run then breaks the claim on the password it returned", async () => {
    for (const user of ["z.looseObject({ name: z.string() })", "z.object({ name: z.string(), password: z.string().optional(), deleted_at: z.string().optional() })"]) {
      const rootDir = await project({ "features/steps/a-user-signs-up.ts": signUp(user, user), ...steps, "features/t.feature": feature });
      const checked = await cli(rootDir, ["check", "features/t.feature"]);
      expect(checked.stdout).not.toContain("claim-field-stripped");
      const result = await cli(rootDir, ["run", "features/t.feature"]);
      expect(result.exitCode).toBe(1);
      const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
      expect(summary.split("\n").filter((line) => line.startsWith("  - ") && line.includes("; measured: "))).toEqual([
        '  - {"name":"aki","password":"secret"} (from:a-user-signs-up@3.user) lacks-field "password" (literal:password) broken; field "password" is present and holds "secret"; measured: none',
        '  - {"name":"aki","password":"secret"} (from:a-user-signs-up@6.user) lacks-field "password" (sentence:field) broken; field "password" is present and holds "secret"; measured: none',
        `  - each of from:a-user-signs-up@10.users (1 item) where item lacks-field "deleted_at" (literal:deleted_at): item lacks-field "password" (literal:password) broken; item 0 (name "aki"): {"name":"aki","password":"secret"} (from:a-user-signs-up@10.users.0) lacks-field "password" (literal:password); measured: none`,
      ]);
    }
  });

  it("is named on the producer's step record, at each object its returns dropped it from, in a run and in nuka do", async () => {
    const signUpOnly = ["Feature: sign up", "  Scenario: sign up", "    When a user signs up", ""].join("\n");
    for (const [user, dropped] of [
      ["z.object({ name: z.string() })", [{ at: ["user"], keys: ["password"] }, { at: ["users", "0"], keys: ["password"] }]],
      ["z.looseObject({ name: z.string() })", []],
      ["z.object({ name: z.string(), password: z.string() })", []],
    ] as const) {
      const rootDir = await project({ "features/steps/a-user-signs-up.ts": signUp(user, user), "features/t.feature": signUpOnly });
      expect((await cli(rootDir, ["run", "features/t.feature"])).exitCode).toBe(0);
      const step = latestRunJson(rootDir).scenarios[0].steps[0] as { record: string };
      const record = JSON.parse(await readFile(path.join(latestRunDir(rootDir), step.record, "record.json"), "utf8")) as Record<string, unknown>;
      expect(record.returns_dropped).toEqual(dropped);
      const done = await cli(rootDir, ["do", "a-user-signs-up", "--args", "{}"]);
      expect(done.exitCode).toBe(0);
      expect(JSON.parse(done.stdout).returns_dropped).toEqual(dropped);
    }
  });

  it("leaves a claim that held without a key the producer's record says its returns dropped unjudged, under --no-check and in nuka do --use", async () => {
    const dropping = "z.object({ name: z.string() })";
    const rootDir = await project({ "features/steps/a-user-signs-up.ts": signUp(dropping, dropping), ...steps, "features/t.feature": feature });
    const ran = await cli(rootDir, ["run", "--no-check", "features/t.feature"]);
    expect(ran.exitCode).toBe(1);
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary.split("\n").filter((line) => line.startsWith("  - ") && line.includes("; measured: "))).toEqual([
      '  - {"name":"aki"} (from:a-user-signs-up@3.user) lacks-field "password" (literal:password) unjudged: step "a-user-signs-up" returned password at from:a-user-signs-up@3.user, and its returns dropped it, so the password field was there, and the claim was not judged; measured: none',
      '  - {"name":"aki"} (from:a-user-signs-up@6.user) lacks-field "password" (sentence:field) unjudged: step "a-user-signs-up" returned password at from:a-user-signs-up@6.user, and its returns dropped it, so the password field was there, and the claim was not judged; measured: none',
      '  - each of from:a-user-signs-up@10.users (1 item) where item lacks-field "deleted_at" (literal:deleted_at): item lacks-field "password" (literal:password) unjudged; item 0: {"name":"aki"} (from:a-user-signs-up@10.users.0) lacks-field "password" (literal:password): step "a-user-signs-up" returned password at from:a-user-signs-up@10.users.0, and its returns dropped it, so the password field was there, and the claim was not judged; measured: none',
    ]);

    const signedUp = await cli(rootDir, ["do", "a-user-signs-up", "--args", "{}"]);
    const producer = JSON.parse(signedUp.stdout).step_record_id as string;
    const measuredReason = `step "a-user-signs-up" returned password at from:a-user-signs-up@${producer}.user, and its returns dropped it, so the password field was there, and the claim was not judged`;
    const done = await cli(rootDir, ["do", "the-user-has-no-password-field", "--use", producer]);
    expect(done.exitCode).toBe(1);
    expect(JSON.parse(done.stdout).claims[0]).toMatchObject({ outcome: "unjudged", reason: measuredReason });

    // A record from before the field says nothing of what was dropped, so
    // the claim reads what the producer's returns declares there.
    const recordPath = path.join(rootDir, ".nukadoko", "do", producer, "record.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    delete record.returns_dropped;
    await writeFile(recordPath, JSON.stringify(record));
    const old = await cli(rootDir, ["do", "the-user-has-no-password-field", "--use", producer]);
    expect(old.exitCode).toBe(1);
    expect(JSON.parse(old.stdout).claims[0]).toMatchObject({
      outcome: "unjudged",
      reason: `the record of step "a-user-signs-up" does not say which keys its returns dropped, and its returns parses from:a-user-signs-up@${producer}.user with an object schema that declares name and drops any key it does not declare, so a password field may have been there, and the claim was not judged`,
    });
  });

  it("judges a claim on a value the producer's returns dropped nothing from, through the same z.object", async () => {
    const userStep = (returned: string) => `import { defineStep, z } from "nukadoko";
export default defineStep({
  description: "Signs a user up",
  pattern: "a user signs up",
  args: z.object({}),
  returns: z.object({ user: z.object({ name: z.string() }) }),
  mutates: false,
  run() {
    return { user: ${returned} };
  },
});
`;
    const equalStep = `import { defineStep, z } from "nukadoko";
import signUp from "./a-user-signs-up.ts";
export default defineStep({
  pattern: "the user is",
  args: z.object({ user: z.unknown(), docstring: z.string() }),
  from: { user: [signUp, "user"] },
  claims: [{ actual: "user", compare: "equal", expected: "docstring", expected_view: "json" }],
});
`;
    for (const [returned, outcome, dropped] of [
      ['{ name: "aki" }', "held", []],
      ['{ name: "aki", password: "secret" }', "unjudged", [{ at: ["user"], keys: ["password"] }]],
    ] as const) {
      const rootDir = await project({
        "features/steps/a-user-signs-up.ts": userStep(returned),
        "features/steps/the-user-is.ts": equalStep,
        "features/t.feature": ["Feature: sign up", "  Scenario: sign up", "    When a user signs up", "    Then the user is", '      """', '      {"name":"aki"}', '      """', ""].join("\n"),
      });
      const ran = await cli(rootDir, ["run", "features/t.feature"]);
      expect(ran.exitCode).toBe(outcome === "held" ? 0 : 1);
      const [signedUp, judged] = latestRunJson(rootDir).scenarios[0].steps as Record<string, any>[];
      const record = JSON.parse(await readFile(path.join(latestRunDir(rootDir), signedUp!.record, "record.json"), "utf8")) as Record<string, unknown>;
      expect(record.returns_dropped).toEqual(dropped);
      expect(judged!.claims[0]).toMatchObject({ actual: { name: "aki" }, compare: "equal", expected: { name: "aki" }, outcome });
    }
  });

  /** A step that returns nothing, so the wrapper above each object in its
   * returns hands back the fallback the test names. */
  const openAccount = (account: string, users: string) => `import { defineStep, z } from "nukadoko";
export default defineStep({
  description: "Opens an account",
  pattern: "an account opens",
  args: z.object({}),
  returns: z.object({
    account: z.object({ user: z.object({ name: z.string() }) }).${account}({ user: { name: "kei", password: "from the fallback" } }),
    users: z.array(z.object({ name: z.string() })).${users}([{ name: "kei", password: "from the fallback" }]),
  }),
  mutates: false,
  run() {
    return {} as any;
  },
});
`;
  const accountSteps = {
    "features/steps/the-account-user-has-no-password-field.ts": `import { defineStep, z } from "nukadoko";
import open from "./an-account-opens.ts";
export default defineStep({
  pattern: "the account user has no password field",
  args: z.object({ account: z.unknown() }),
  from: { account: [open, "account"] },
  claims: [{ actual: "account", at: "user", compare: "lacks-field", expected: { literal: "password" } }],
});
`,
    "features/steps/every-user-has-no-password-field.ts": `import { defineStep, z } from "nukadoko";
import open from "./an-account-opens.ts";
export default defineStep({
  pattern: "every user has no password field",
  args: z.object({ users: z.unknown() }),
  from: { users: [open, "users"] },
  claims: [{ actual: "users", each: { claims: [{ compare: "lacks-field", expected: { literal: "password" } }] } }],
});
`,
    "features/t.feature": [
      "Feature: accounts",
      "  Scenario: the account user",
      "    When an account opens",
      "    Then the account user has no password field",
      "  Scenario: every user",
      "    When an account opens",
      "    Then every user has no password field",
      "",
    ].join("\n"),
  };

  it("is not reported below a default or a catch, whose own value skips the schema, and the run then breaks the claim on the field that value holds", async () => {
    const rootDir = await project({ "features/steps/an-account-opens.ts": openAccount("default", "catch"), ...accountSteps });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.stdout).not.toContain("claim-field-stripped");
    const result = await cli(rootDir, ["run", "features/t.feature"]);
    expect(result.exitCode).toBe(1);
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary.split("\n").filter((line) => line.startsWith("  - ") && line.includes("; measured: "))).toEqual([
      '  - {"name":"kei","password":"from the fallback"} (from:an-account-opens@3.account.user) lacks-field "password" (literal:password) broken; field "password" is present and holds "from the fallback"; measured: none',
      '  - each of from:an-account-opens@6.users (1 item): item lacks-field "password" (literal:password) broken; item 0 (name "kei"): {"name":"kei","password":"from the fallback"} (from:an-account-opens@6.users.0) lacks-field "password" (literal:password); measured: none',
    ]);
  });

  it("is reported below a prefault, whose value the schema parses", async () => {
    const rootDir = await project({ "features/steps/an-account-opens.ts": openAccount("prefault", "prefault"), ...accountSteps });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.stdout.split("\n").filter((line) => line.startsWith("error\tclaim-field-stripped\t"))).toEqual([
      'error\tclaim-field-stripped\tfeatures/t.feature:4\tStep "the-account-user-has-no-password-field"\'s claims[0] is lacks-field "password" on account at user, and step "an-account-opens" on line 3 returns that value through an object schema that declares name, which drops any key it does not declare, or refuses it as a strict object. password is never there, so the claim never breaks, whatever the behaviour is',
      'error\tclaim-field-stripped\tfeatures/t.feature:7\tStep "every-user-has-no-password-field"\'s claims[0].each.claims[0] is lacks-field "password" on each item of users, and step "an-account-opens" on line 6 returns that value through an object schema that declares name, which drops any key it does not declare, or refuses it as a strict object. password is never there, so the claim never breaks, whatever the behaviour is',
    ]);
    expect(checked.exitCode).toBe(1);
  });
});

describe("a claim its compare could never judge as the sentence means it, refused at import", () => {
  /** A claim step that observes a body and an output, and reads a key of
   * the step that answers, so a claim can name either side. */
  const step = (pattern: string, args: string, claim: string) => `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "${pattern}",
  args: z.object({ ${args} }),
  from: { said: [answer, "out"] },
  observe() {
    return { body: { id: 1 }, printed: "a" };
  },
  claims: [${claim}] as any,
});
`;

  it.each([
    [
      "has-fields with a literal",
      step("the body is done", "said: z.string()", `{ actual: "body", compare: "has-fields", expected: { literal: "done" } }, { actual: "said", compare: "equal", expected: { observe: "printed" } }`),
      'claims[0].expected is the literal "done", which is never an object, and has-fields compares two objects, so the claim always breaks. Take the expected object from the docstring, read as JSON with expected_view: "json"',
    ],
    [
      "has-fields with a sentence key read as it is",
      step("the body reads", "fields: z.string(), said: z.string()", `{ actual: "body", compare: "has-fields", expected: "fields" }`),
      'claims[0].expected is args.fields, which a line fills with a capture\'s value, the docstring\'s text, or the table\'s cells, never an object, so has-fields always breaks. Read the docstring as JSON with expected_view: "json"',
    ],
    [
      "has-fields with a sentence key read as lines",
      step("the body reads", "fields: z.string(), said: z.string()", `{ actual: "body", compare: "has-fields", expected: "fields", expected_view: "lines" }`),
      'claims[0].expected reads args.fields through expected_view lines, which makes an array, never an object, so has-fields always breaks. Read the docstring as JSON with expected_view: "json"',
    ],
    [
      "fits-text with an expected text an earlier step returned",
      step("the output is the same", "said: z.string()", `{ actual: "printed", compare: "fits-text", expected: { from: "said" } }`),
      'claims[0].expected reads { from: "said" }, a value a step returned, and fits-text reads each "..." line and each "[..]" of its expected text as a stand-in, so a value that holds one lets text nobody stated fit. Take the expected text from the sentence: a docstring, a capture, or a literal',
    ],
    [
      "fits-text with an expected text observe read",
      step("the output is the same", "said: z.string()", `{ actual: "said", compare: "fits-text", expected: { observe: "printed" } }`),
      'claims[0].expected reads { observe: "printed" }, a value observe read, and fits-text reads each "..." line and each "[..]" of its expected text as a stand-in, so a value that holds one lets text nobody stated fit. Take the expected text from the sentence: a docstring, a capture, or a literal',
    ],
    [
      "is-a with a literal that names no kind",
      step("the id is a snowflake", "said: z.string()", `{ actual: "body.id", compare: "is-a", expected: { literal: "snowflake" } }`),
      'claims[0].expected is the literal "snowflake", and is-a names one of the kinds string, text, number, integer, boolean, list, array, object, null, uuid, date, timestamp, url, so the claim always breaks. State one of them in the pattern\'s fixed words',
    ],
    [
      "is-a with a literal that is no text",
      step("the id is 3", "said: z.string()", `{ actual: "body.id", compare: "is-a", expected: { literal: 3 } }`),
      'claims[0].expected is the literal 3, and is-a names one of the kinds string, text, number, integer, boolean, list, array, object, null, uuid, date, timestamp, url, so the claim always breaks. State one of them in the pattern\'s fixed words',
    ],
    [
      "is-a string on a value read as text",
      step("the output is a string", "said: z.string()", `{ actual: "printed", view: "text", compare: "is-a", expected: { literal: "string" } }`),
      'claims[0] reads its actual value through view text, which always makes a string, so is-a "string" holds whenever the view applies and states nothing. Name a kind a string may not be, such as uuid, date, timestamp, or url, or claim the value itself',
    ],
    [
      "is-a list on a value read as lines",
      step("the output is a list", "said: z.string()", `{ actual: "printed", view: "lines", compare: "is-a", expected: { literal: "list" } }`),
      'claims[0] reads its actual value through view lines, which always makes an array, so is-a "list" holds whenever the view applies and states nothing. Claim what its items are with each, or claim the value itself',
    ],
    [
      "is-a array on a value read as a comma list",
      step("the output is an array", "said: z.string()", `{ actual: "printed", view: "comma-list", compare: "is-a", expected: { literal: "array" } }`),
      'claims[0] reads its actual value through view comma-list, which always makes an array, so is-a "array" holds whenever the view applies and states nothing. Claim what its items are with each, or claim the value itself',
    ],
    [
      "a count with a compare that does not compare two numbers",
      step("the body has items", "said: z.string()", `{ actual: "body", count: true, compare: "has-item", expected: { observe: "printed" } }`),
      "claims[0] counts the items of its actual value, which makes a number, and has-item does not compare two numbers, so the claim would break on every line or hold on every line. Compare the count with equal, not-equal, greater-than, at-least, less-than, at-most",
    ],
    [
      "a count with a literal that is no number",
      step("no item is left", "said: z.string()", `{ actual: "body", count: true, compare: "equal", expected: { literal: [] } }`),
      "claims[0] counts the items of its actual value, which makes a number, and its expected value is the literal [], which is never a number, so the claim always breaks. State the number in the pattern, as digits or a number word, and write it as a number literal",
    ],
    [
      "lacks-field with a literal that is no field name",
      step("the body has no field 3", "said: z.string()", `{ actual: "body", compare: "lacks-field", expected: { literal: 3 } }`),
      "claims[0].expected is the literal 3, which is never the name of a field, and lacks-field names the field its actual object lacks, so the claim always breaks. State the field's name in the pattern's fixed words",
    ],
    [
      "lacks-field on a value read as text",
      step("the output has no password field", "said: z.string()", `{ actual: "printed", view: "text", compare: "lacks-field", expected: { literal: "password" } }`),
      "claims[0] reads its actual value through view text, which always makes a string and never an object, so lacks-field always breaks. Read the text with view json, or claim a value that is an object",
    ],
    [
      "has-fields on a value read as lines",
      step("the output reads", "fields: z.string(), said: z.string()", `{ actual: "printed", view: "lines", compare: "has-fields", expected: "fields", expected_view: "json" }, { actual: "said", compare: "equal", expected: { observe: "printed" } }`),
      "claims[0] reads its actual value through view lines, which always makes an array and never an object, so has-fields always breaks. Read the text with view json, or claim a value that is an object",
    ],
  ])("refuses %s", async (_name, source, message) => {
    const rootDir = await project({
      "features/steps/claim.ts": source,
      "features/t.feature": feature("When the app answers", `Then ${/pattern: "([^"]*)"/.exec(source)![1]}`),
    });
    const checked = await cli(rootDir, ["check", "features/t.feature"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout + checked.stderr).toContain(`defineStep ${message}.`);
  });
});
