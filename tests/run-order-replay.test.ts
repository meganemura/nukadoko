import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { inRunOrder } from "../src/run/run-order.js";
import { feature, makeBaseProject, scenario } from "./helpers/base-project.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka run --order` against a program whose scenarios
// depend on each other's data (tests/fixtures/run-order-project): in file
// order every scenario passes, a shuffled order breaks the ones that need
// an earlier scenario or that one pollutes, the seed is said on stderr, in
// run.json, and in the summary, and each failed scenario's rerun line runs
// the same failure again. The fixture's world holds its accounts in
// memory: "nobody has signed up yet" passes only before "alice signs up",
// and "alice signs in" passes only after it.

const NOBODY = { feature: "features/accounts.feature", line: 3 };
const ALICE_SIGNS_UP = { feature: "features/accounts.feature", line: 6 };
const ALICE_SIGNS_IN = { feature: "features/sign-in.feature", line: 3 };

interface RunDocument {
  readonly verdict: string;
  readonly order?: { readonly kind: string; readonly seed?: number };
  readonly scenarios: readonly { readonly feature: string; readonly line: number; readonly status: string; readonly do?: string }[];
}

async function run(rootDir: string, argv: readonly string[]): Promise<{ exitCode: number; document: RunDocument; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["run", "--json", ...argv], { rootDir, stdout, stderr });
  return { exitCode, document: JSON.parse(stdout.text()) as RunDocument, stderr: stderr.text() };
}

// The arguments of a `nuka run` line the run printed, which hold no
// quoting: the fixture's paths are plain words.
function argsOf(command: string): string[] {
  const words = command.split(" ");
  expect(words.slice(0, 2)).toEqual(["nuka", "run"]);
  return words.slice(2);
}

function ran(document: RunDocument): string[] {
  return document.scenarios.map((scenario) => `${scenario.feature}:${scenario.line} ${scenario.status}`);
}

// A seed whose order meets `wanted`, found by the order itself: the order
// a seed names is pinned in tests/run-order.test.ts.
function seedWhere(wanted: (sequence: readonly string[]) => boolean): number {
  const file = (relativePath: string, lines: readonly number[]) => ({ relativePath, pickles: lines.map((line) => ({ location: { line } })), selectedLines: null });
  for (let seed = 0; ; seed += 1) {
    const sequence = inRunOrder([file(NOBODY.feature, [NOBODY.line, ALICE_SIGNS_UP.line]), file(ALICE_SIGNS_IN.feature, [ALICE_SIGNS_IN.line])], { kind: "shuffled", seed }).flatMap(
      (entry) => entry.pickles.map((pickle) => `${entry.relativePath}:${pickle.location.line}`),
    );
    if (wanted(sequence)) return seed;
  }
}

const at = (place: { feature: string; line: number }) => `${place.feature}:${place.line}`;
// alice signs up, then nobody has signed up yet, then alice signs in: only
// the second fails, and it passes when it runs alone.
const polluting = seedWhere((sequence) => sequence.join(" ") === [ALICE_SIGNS_UP, NOBODY, ALICE_SIGNS_IN].map(at).join(" "));
// alice signs in first: it fails, and fails alone too.
const signInFirst = seedWhere((sequence) => sequence[0] === at(ALICE_SIGNS_IN));

describe("nuka run --order", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-order-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("passes in file order, which a run without --order runs and records", async () => {
    const { exitCode, document, stderr } = await run(rootDir, []);
    expect(exitCode, stderr).toBe(0);
    expect(document.order).toEqual({ kind: "file" });
    expect(ran(document)).toEqual([`${at(NOBODY)} passed`, `${at(ALICE_SIGNS_UP)} passed`, `${at(ALICE_SIGNS_IN)} passed`]);
  });

  it("breaks a scenario an earlier one polluted, and its rerun line breaks it again where running it alone passes", async () => {
    const { exitCode, document } = await run(rootDir, ["--order", `shuffled:${polluting}`]);
    expect(exitCode).toBe(1);
    expect(document.order).toEqual({ kind: "shuffled", seed: polluting });
    expect(ran(document)).toEqual([`${at(ALICE_SIGNS_UP)} passed`, `${at(NOBODY)} failed`, `${at(ALICE_SIGNS_IN)} passed`]);
    const failed = document.scenarios.find((scenario) => scenario.status === "failed")!;
    // Both scenarios of the file ran by then, and the target named the file.
    expect(failed.do).toBe(`nuka run features/accounts.feature --order shuffled:${polluting}`);

    const rerun = await run(rootDir, argsOf(failed.do!));
    expect(rerun.exitCode).toBe(1);
    expect(ran(rerun.document)).toEqual([`${at(ALICE_SIGNS_UP)} passed`, `${at(NOBODY)} failed`]);
    expect(rerun.document.scenarios[1]!.do).toBe(failed.do);

    const alone = await run(rootDir, [at(NOBODY), "--order", `shuffled:${polluting}`]);
    expect(alone.exitCode).toBe(0);
  });

  it("names a file's lines when only some of them ran before the failed scenario", async () => {
    const { document } = await run(rootDir, ["features/accounts.feature:3", "features/accounts.feature:6", "features/sign-in.feature", "--order", `shuffled:${polluting}`]);
    expect(document.scenarios.find((scenario) => scenario.status === "failed")!.do).toBe(
      `nuka run features/accounts.feature:6 features/accounts.feature:3 --order shuffled:${polluting}`,
    );
  });

  it("breaks a scenario that runs before the one it needs, and says the seed on stderr and in the summary", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--order", `shuffled:${signInFirst}`], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode).toBe(1);
    expect(stderr.text().split("\n")[0]).toBe(`order shuffled:${signInFirst}`);
    expect(stderr.text()).toContain(`failed\tscenario-failed\t${at(ALICE_SIGNS_IN)}\t`);
    expect(stderr.text()).toContain(`  do: nuka run features/sign-in.feature --order shuffled:${signInFirst}\n`);
    const summary = await readFile(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain(`- order: shuffled, seed ${signInFirst} (\`--order shuffled:${signInFirst}\` runs this order again)`);
    expect(summary).toContain(`nuka run features/sign-in.feature --order shuffled:${signInFirst}`);
  });

  it("records a seed it drew the way it records one it was given", async () => {
    const { document, stderr } = await run(rootDir, ["--order", "shuffled"]);
    expect(stderr).toBe("");
    expect(document.order?.kind).toBe("shuffled");
    const seed = document.order!.seed!;
    expect(Number.isInteger(seed)).toBe(true);
    for (const scenario of document.scenarios) {
      if (scenario.do !== undefined) expect(scenario.do).toMatch(new RegExp(` --order shuffled:${seed}$`));
    }
    const again = await run(rootDir, ["--order", `shuffled:${seed}`]);
    expect(ran(again.document)).toEqual(ran(document));
  });

  it("names the run itself as the rerun under --repeat, where earlier passes ran before the failure", async () => {
    // In file order's sequence a second pass meets alice from the first.
    const fileOrder = seedWhere((sequence) => sequence.join(" ") === [NOBODY, ALICE_SIGNS_UP, ALICE_SIGNS_IN].map(at).join(" "));
    const { document } = await run(rootDir, ["--order", `shuffled:${fileOrder}`, "--repeat", "2"]);
    const failed = document.scenarios.filter((scenario) => scenario.status === "failed");
    expect(failed.map((scenario) => `${at(scenario)} ${scenario.do}`)).toEqual([`${at(NOBODY)} nuka run --order shuffled:${fileOrder} --repeat 2`]);
    const rerun = await run(rootDir, argsOf(failed[0]!.do!));
    expect(ran(rerun.document)).toEqual(ran(document));
  });

  it("runs a file's scenarios in the shuffled order inside a worker under --concurrency", async () => {
    const { document } = await run(rootDir, ["--order", `shuffled:${polluting}`, "--concurrency", "2"]);
    const accounts = document.scenarios.filter((scenario) => scenario.feature === NOBODY.feature).map((scenario) => scenario.line);
    expect(accounts).toEqual([ALICE_SIGNS_UP.line, NOBODY.line]);
    expect(document.scenarios.find((scenario) => scenario.status === "failed")!.do).toBe(`nuka run --order shuffled:${polluting} --concurrency 2`);
  });

  it("refuses an order it does not know", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--json", "--order", "random"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(exitCode).toBe(2);
    const refusal = (JSON.parse(stdout.text()) as { findings: { code: string; message: string }[] }).findings[0]!;
    expect(refusal.code).toBe("invalid-value");
    expect(refusal.message).toContain('(got "random")');
  });
});

describe("nuka run --order with --base", () => {
  it("runs the base world's cells in the order head ran their rows", async () => {
    const project = await makeBaseProject();
    try {
      project.write({ "features/cart.feature": feature(scenario("one item", 1, 2)) });
      const base = project.commit("base");
      // Four new criteria, each with a cell in the base world.
      project.write({
        "features/cart.feature": feature(scenario("one item", 1, 2), scenario("two items", 2, 4), scenario("three items", 3, 6)),
        "features/more.feature": "Feature: More\n\n" + scenario("four items", 4, 8) + "\n" + scenario("five items", 5, 10),
      });
      project.commit("head");
      const file = (relativePath: string, lines: readonly number[]) => ({ relativePath, pickles: lines.map((line) => ({ location: { line } })), selectedLines: null });
      const fresh = ["features/cart.feature:7", "features/cart.feature:11", "features/more.feature:3", "features/more.feature:7"];
      const orderOf = (seed: number) =>
        inRunOrder([file("features/cart.feature", [3, 7, 11]), file("features/more.feature", [3, 7])], { kind: "shuffled", seed })
          .flatMap((entry) => entry.pickles.map((pickle) => `${entry.relativePath}:${pickle.location.line}`))
          .filter((key) => fresh.includes(key));
      let seed = 0;
      while (orderOf(seed).join(" ") === fresh.join(" ")) seed += 1;

      const result = await project.cli(["run", "--json", "--order", `shuffled:${seed}`, "--base", base]);
      const document = JSON.parse(result.stdout) as { scenarios: { feature: string; line: number; world?: string; row?: { feature: string; line: number } }[] };
      const head = document.scenarios.filter((entry) => entry.world === undefined).map((entry) => `${entry.feature}:${entry.line}`);
      // A row's proof runs come after the pass, so each row counts once, where
      // its first base cell ran.
      const inBase = [...new Set(document.scenarios.filter((entry) => entry.world === "base").map((entry) => `${entry.row!.feature}:${entry.row!.line}`))];
      expect(head.filter((key) => fresh.includes(key))).toEqual(orderOf(seed));
      expect(inBase).toEqual(orderOf(seed));
    } finally {
      await removeTempDir(project.top);
    }
  }, 120_000);
});
