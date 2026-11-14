import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../src/cli/run-cli.js";
import { defineStep, InvalidStepDefinitionError, type ClaimStepDefinition } from "../src/step/define-step.js";
import { readStates, STATE_LISTS, type StateList, type StateUse } from "../src/step/states.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// A step's requires, gives, and ends (docs/spec.md "States"): what
// defineStep keeps, what it refuses at import, and what nuka steps and
// nuka describe show an agent composing a scenario.

const person = z.object({ person: z.string() });

function refusal(define: () => unknown): string {
  try {
    define();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidStepDefinitionError);
    return (error as Error).message;
  }
  throw new Error("defineStep accepted the definition");
}

describe("defineStep: requires, gives, and ends", () => {
  it("keeps each entry as a state and the args key that names its holder", () => {
    const step = defineStep({
      pattern: "{person:word} signs out",
      description: "d",
      args: person,
      requires: [["signed-in", "person"], "account-menu"],
      ends: [["signed-in", "person"]],
      run() {},
    });
    expect(step.states).toEqual({
      requires: [
        { state: "signed-in", key: "person" },
        { state: "account-menu", key: undefined },
      ],
      gives: [],
      ends: [{ state: "signed-in", key: "person" }],
    });
    expect(Object.isFrozen(step.states.requires)).toBe(true);
  });

  it("gives every step empty lists when it declares none", () => {
    const step = defineStep({ description: "d", args: z.object({}), run() {} });
    expect(step.states).toEqual({ requires: [], gives: [], ends: [] });
  });

  it("lets a claim step require a state", () => {
    const step = defineStep({
      pattern: "{person:word} sees the {item:word} item",
      args: z.object({ person: z.string(), item: z.string() }),
      requires: [["signed-in", "person"]],
      observe: () => ({ items: ["settings"] }),
      claims: [{ actual: "items", compare: "has-item", expected: "item" }],
    });
    expect(step.states.requires).toEqual([{ state: "signed-in", key: "person" }]);
  });

  it("refuses a key args does not declare, at compile time and at import", () => {
    expect(
      refusal(() =>
        defineStep({
          description: "d",
          args: person,
          // @ts-expect-error "persn" is not a key of args
          gives: [["signed-in", "persn"]],
          run() {},
        }),
      ),
    ).toBe('defineStep gives[0] names args key "persn", which args does not declare: args declares "person".');
  });

  it("refuses a keyed state on a step whose args is not a z.object", () => {
    expect(
      refusal(() =>
        defineStep({
          description: "d",
          args: z.string(),
          // @ts-expect-error a step whose args is not an object has no key
          requires: [["signed-in", "person"]],
          run() {},
        }),
      ),
    ).toBe('defineStep requires[0] names args key "person", which args does not declare: args is not a z.object, so a state on this step cannot name a key.');
  });

  it("refuses gives and ends on a claim step", () => {
    const definition: ClaimStepDefinition<typeof person> = {
      args: person,
      // @ts-expect-error a claim step leaves no state
      gives: [["signed-in", "person"]],
      observe: () => ({ items: ["settings"] }),
      claims: [{ actual: "items", compare: "has-item", expected: "person" }],
    };
    expect(refusal(() => defineStep(definition))).toBe(
      "defineStep gives is not an option of a claim step: a claim step has no action, so it leaves no state; it may require one.",
    );
  });

  it("refuses one state in both gives and ends", () => {
    expect(
      refusal(() =>
        defineStep({
          description: "d",
          args: person,
          gives: ["book-open", ["signed-in", "person"]],
          ends: [["signed-in", "person"]],
          run() {},
        }),
      ),
    ).toBe('defineStep gives[1] and ends[0] both name ["signed-in", "person"], and a step leaves a state one way.');
  });

  it("refuses an entry listed twice, a name with space at its end, and an entry of neither form", () => {
    expect(refusal(() => defineStep({ description: "d", args: person, requires: ["a", "b", "a"], run() {} }))).toBe(
      'defineStep requires[2] repeats "a" from requires[0].',
    );
    expect(refusal(() => defineStep({ description: "d", args: person, ends: ["book-open "], run() {} }))).toBe(
      'defineStep ends[0] names the state "book-open ", and a state name is not empty and has no space at either end.',
    );
    expect(refusal(() => defineStep({ description: "d", args: person, gives: [["signed-in"] as never], run() {} }))).toBe(
      'defineStep gives[0] is not a state: write a name ("signed-in") or a [name, key] pair (["signed-in", "person"]).',
    );
    expect(refusal(() => defineStep({ description: "d", args: person, gives: "signed-in" as never, run() {} }))).toBe(
      'defineStep gives must be an array of states, each a name ("signed-in") or a [name, key] pair (["signed-in", "person"]).',
    );
  });

  it("reports a refused declaration as the step file's import failure", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], { rootDir: fixture("state-order-refused-project"), stdout, stderr: createCaptureSink() });
    const report = JSON.parse(stdout.text()) as { findings: Array<{ code: string; file?: string; message: string }> };
    const failures = report.findings.filter((finding) => finding.code === "step-file-import-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.file).toBe("features/steps/sign-in.ts");
    expect(failures[0]!.message).toContain('defineStep gives[0] names args key "persn", which args does not declare: args declares "person".');
  });
});

describe("readStates", () => {
  const names = gs.sampledFrom(["signed-in", "in-room", "book-open"]);
  const keySets = gs.sampledFrom([null, [], ["person"], ["person", "host"]] as const);

  /** An entry as a step file writes it. */
  const refOf = (use: StateUse): unknown => (use.key === undefined ? use.state : [use.state, use.key]);

  function wellFormedLists(tc: hegel.TestCase, keys: readonly string[] | null): Record<StateList, StateUse[]> {
    const entry = gs.composite((inner) => {
      const keyed = keys !== null && keys.length > 0 && inner.draw(gs.booleans());
      return { state: inner.draw(names), key: keyed ? inner.draw(gs.sampledFrom(keys)) : undefined };
    });
    const unique = (uses: readonly StateUse[]): StateUse[] =>
      uses.filter((use, index) => uses.findIndex((other) => other.state === use.state && other.key === use.key) === index);
    const requires = unique(tc.draw(gs.arrays(entry, { maxSize: 4 })));
    const gives = unique(tc.draw(gs.arrays(entry, { maxSize: 4 })));
    const ends = unique(tc.draw(gs.arrays(entry, { maxSize: 4 }))).filter(
      (use) => !gives.some((given) => given.state === use.state && given.key === use.key),
    );
    return { requires, gives, ends };
  }

  it("accepts every well-formed declaration, and reading what it kept gives the same states", () =>
    hegel.test((tc) => {
      const keys = tc.draw(keySets);
      const lists = wellFormedLists(tc, keys);
      const argsKeys = keys === null ? null : new Set(keys);
      const read = readStates(
        { requires: lists.requires.map(refOf), gives: lists.gives.map(refOf), ends: lists.ends.map(refOf) },
        argsKeys,
      );
      expect(read).toEqual({ states: lists });
      if (!("states" in read)) return;
      const again = readStates(
        Object.fromEntries(STATE_LISTS.map((list) => [list, read.states[list].map(refOf)])),
        argsKeys,
      );
      expect(again).toEqual(read);
    }));

  it("names the list and index of an entry outside the grammar", () =>
    hegel.test((tc) => {
      const keys = tc.draw(keySets);
      const lists = wellFormedLists(tc, keys);
      const list = tc.draw(gs.sampledFrom(STATE_LISTS));
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: lists[list].length }));
      const bad = tc.draw(
        gs.sampledFrom<unknown>([7, null, {}, ["signed-in"], ["signed-in", "person", "x"], [1, 2], "", " signed-in", "signed-in ", ["", "person"], ["in-room", "nobody"]]),
      );
      const written: Record<string, unknown[]> = Object.fromEntries(STATE_LISTS.map((name) => [name, lists[name].map(refOf)]));
      written[list]!.splice(index, 0, bad);
      const read = readStates(written, keys === null ? null : new Set(keys));
      expect("problem" in read && read.problem.startsWith(`${list}[${index}] `)).toBe(true);
    }));
});

describe("nuka steps and nuka describe show the states", () => {
  const rootDir = fixture("state-order-project");

  it("lists requires with the steps that give each state, and gives and ends as declared", async () => {
    const stdout = createCaptureSink();
    expect(await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    const steps = (JSON.parse(stdout.text()) as { steps: Array<Record<string, unknown>> }).steps;
    const byName = new Map(steps.map((step) => [step.name, step]));
    expect(byName.get("open-settings")!.requires).toEqual([{ state: "signed-in", key: "person", given_by: ["sign-in"] }]);
    expect(byName.get("sign-in")!.gives).toEqual([{ state: "signed-in", key: "person" }]);
    expect(byName.get("sign-out")).toMatchObject({
      requires: [{ state: "signed-in", key: "person", given_by: ["sign-in"] }],
      ends: [{ state: "signed-in", key: "person" }],
    });
    for (const field of ["requires", "gives", "ends"]) {
      expect(byName.get("try-to-open-settings")).not.toHaveProperty(field);
    }
  });

  it("names in given_by only the steps with a pattern, the steps a line can run", async () => {
    const dir = await copyFixtureToTempDir("state-order-project");
    try {
      const steps = path.join(dir, "features", "steps");
      await writeFile(
        path.join(steps, "sign-in.ts"),
        [
          'import { defineStep, z } from "../../nukadoko-shim.js";',
          "",
          "export default defineStep({",
          '  description: "Sign in with the person\'s test account",',
          "  args: z.object({ person: z.string() }),",
          '  gives: [["signed-in", "person"]],',
          "  run() {},",
          "});",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(steps, "sign-in-from-home.ts"),
        [
          'import { defineStep, z } from "../../nukadoko-shim.js";',
          'import signIn from "./sign-in.js";',
          "",
          "export default defineStep({",
          '  pattern: "{person:word} signs in from the home page",',
          '  description: "Sign in from the home page",',
          "  args: z.object({ person: z.string() }),",
          "  parts: [signIn],",
          '  gives: [["signed-in", "person"]],',
          "  async run({ call }, { person }) {",
          "    await call(signIn, { person });",
          "  },",
          "});",
          "",
        ].join("\n"),
      );
      const stdout = createCaptureSink();
      expect(await runCli(["describe", "open-settings"], { rootDir: dir, stdout, stderr: createCaptureSink() })).toBe(0);
      expect((JSON.parse(stdout.text()) as Record<string, unknown>).requires).toEqual([
        { state: "signed-in", key: "person", given_by: ["sign-in-from-home"] },
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("prints one line per entry in the text listing", async () => {
    const stdout = createCaptureSink();
    await runCli(["steps"], { rootDir, stdout, stderr: createCaptureSink() });
    expect(stdout.text()).toContain(
      [
        "sign-out  typed  mutates",
        "  {person:word} signs out",
        "  Sign out from the account menu",
        "  requires: signed-in for person, given by sign-in",
        "  ends: signed-in for person",
      ].join("\n"),
    );
  });

  it("shows the same fields in nuka describe", async () => {
    const stdout = createCaptureSink();
    expect(await runCli(["describe", "sign-out"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(0);
    const contract = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(contract.requires).toEqual([{ state: "signed-in", key: "person", given_by: ["sign-in"] }]);
    expect(contract.ends).toEqual([{ state: "signed-in", key: "person" }]);
    expect(contract).not.toHaveProperty("gives");
  });
});
