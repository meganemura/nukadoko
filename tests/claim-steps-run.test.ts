import { mkdir, readFile, writeFile } from "node:fs/promises";
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

  it("judges the value the producing step returned, whatever observe does to its own copy", async () => {
    const rootDir = await project({
      "features/steps/the-cart-holds.ts": `import { defineStep, z } from "nukadoko";
import answer from "./the-app-answers.ts";
export default defineStep({
  pattern: "the cart holds {n:int} items",
  args: z.object({ n: z.number(), cart: answer.returns.shape.cart }),
  from: { cart: [answer, "cart"] },
  observe({}, { cart }) { (cart as any).count = 3; return {}; },
  claims: [{ actual: "cart.count", compare: "equal", expected: "n" }],
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
    ["att", `{ actual: "cart", att: "count", compare: "equal", expected: { literal: 1 } }`, 'claims[0] has the key "att", which a claim does not have. It has actual, view, at, compare, expected, expected_view'],
    ["wher", `{ actual: "cart.items", each: { wher: [], claims: [{ actual: "paid", compare: "equal", expected: { literal: true } }] } }`, 'claims[0].each has the key "wher", which each does not have. It has where, claims'],
    ["expect", `{ actual: "cart.items", each: { claims: [{ actual: "paid", compare: "equal", expected: { literal: true }, expect: 1 }] } }`, 'claims[0].each.claims[0] has the key "expect", which a claim on one item does not have. It has actual, view, at, compare, expected, expected_view'],
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
      `defineStep claims[0].expected is the literal ${literal}, which the word "${word}" fixes, and claims[0].compare is "${compare}". A value a word fixes is compared with equal alone, or with not-equal alone right after the word \"not\" (\"is not empty\"): another compare against it holds for nearly anything, and the word does not show it.`,
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
      `defineStep claims[0].expected is the literal [], which the words "not empty" rule out, and claims[0].compare is "equal". A value a word fixes is compared with equal alone, or with not-equal alone right after the word \"not\" (\"is not empty\"): another compare against it holds for nearly anything, and the word does not show it.`,
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
      'error\tclaim-compares-itself\tfeatures/t.feature:4\tStep "the-cart-still-holds"\'s observe receives args.now, which is cart of step "the-app-answers" on line 3, and its claims[0].expected reads cart.count of step "the-app-answers" on line 3, so observe could return the value the claim compares it with. Give observe values from another step, or none from this one\n',
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
