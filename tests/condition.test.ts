import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  booleanValueTag,
  conditionTagText,
  meets,
  readConditionTag,
  readCriterionTags,
  roleIn,
  type ConditionTag,
  type Conditions,
} from "../src/condition/condition.js";
import { defaultEnvironmentNames } from "../src/environment/resolve-environment.js";

// Responsibility: the condition tag grammar and the role a scenario's cell
// has in an environment. A tag reads back to the text it was written from,
// a tag outside the three forms never reads, and the roles follow from
// "required where every condition is met, control elsewhere".

const NAME_CHARS = "abcXYZ019_.-";
const name = gs.text({ alphabet: NAME_CHARS, minSize: 1, maxSize: 8 });
// A value a tag can name: no whitespace, no "@", and not the text of a
// boolean.
const value = gs.text({ alphabet: "abz09-_./:=", minSize: 1, maxSize: 8 }).filter((text) => text !== "true" && text !== "false");

const conditionTag = gs.oneOf(
  name.map((n): ConditionTag => ({ kind: "with", name: n })),
  name.map((n): ConditionTag => ({ kind: "without", name: n })),
  gs.tuples(name, value).map(([n, v]): ConditionTag => ({ kind: "with-value", name: n, value: v })),
);

// A small pool of names, so tags and environments name the same ones.
const pooledName = gs.sampledFrom(["a", "b", "c"]);
const pooledTag = gs.oneOf(
  pooledName.map((n): ConditionTag => ({ kind: "with", name: n })),
  pooledName.map((n): ConditionTag => ({ kind: "without", name: n })),
  gs.tuples(pooledName, gs.sampledFrom(["x", "y"])).map(([n, v]): ConditionTag => ({ kind: "with-value", name: n, value: v })),
);
const environment = gs
  .arrays(gs.tuples(pooledName, gs.oneOf(gs.booleans().map((b): boolean | string => b), gs.sampledFrom<boolean | string>(["x", "y"]))), { maxSize: 3 })
  .map((entries): Conditions => Object.fromEntries(entries));
const declared = gs.optional(environment).map((conditions) => conditions ?? undefined);

// The grammar the spec states, written once more as the oracle.
const GRAMMAR = /^(?:@with:[A-Za-z0-9_.-]+(?:=(?!(?:true|false)$)[^\s@]+)?|@without:[A-Za-z0-9_.-]+)$/;

describe("condition tags", () => {
  it("read back to the text they were written from", () =>
    hegel.test((tc) => {
      const tag = tc.draw(conditionTag);
      expect(readConditionTag(conditionTagText(tag))).toEqual(tag);
    }));

  it("read only text in one of the three forms, and that text exactly", () =>
    hegel.test((tc) => {
      const prefix = tc.draw(gs.sampledFrom(["@with:", "@without:"]));
      const body = tc.draw(gs.oneOf(gs.text({ alphabet: "ab_.-=: \té@", maxSize: 8 }), gs.sampledFrom(["a=true", "a=false", "a=truex", "a=@b"])));
      const text = `${prefix}${body}`;
      const read = readConditionTag(text);
      expect(read !== undefined).toBe(GRAMMAR.test(text));
      if (read !== undefined) expect(conditionTagText(read)).toBe(text);
    }));

  it("refuses each malformed shape", () => {
    for (const text of ["@with:", "@without:", "@with:=on", "@with:x=", "@without:x=on", "@with:a b", "@with:é", "@with:x:y", "@with:x=true", "@with:x=false", "@with:x=a@b"]) {
      expect(readConditionTag(text), text).toBeUndefined();
    }
  });

  it("refuse a boolean written as a value, and name the tag that reads it", () =>
    hegel.test((tc) => {
      const n = tc.draw(name);
      const on = tc.draw(gs.booleans());
      const text = `@with:${n}=${on}`;
      expect(readConditionTag(text)).toBeUndefined();
      expect(booleanValueTag(text)).toEqual(on ? { kind: "with", name: n } : { kind: "without", name: n });
      // Any tag that reads names no boolean as text.
      const tag = tc.draw(conditionTag);
      expect(booleanValueTag(conditionTagText(tag))).toBeUndefined();
    }));

  it("reads a scenario's tags once each, with @held and the malformed ones apart", () => {
    expect(readCriterionTags(["@smoke", "@with:a", "@held", "@with:a", "@without:", "@without:b", "@without:"])).toEqual({
      conditions: [
        { kind: "with", name: "a" },
        { kind: "without", name: "b" },
      ],
      held: true,
      malformed: ["@without:"],
    });
  });
});

describe("cell roles", () => {
  it("make a scenario with no condition tag required everywhere", () =>
    hegel.test((tc) => {
      expect(roleIn([], tc.draw(declared))).toBe("required");
    }));

  it("give @with:x and @without:x opposite roles in every environment", () =>
    hegel.test((tc) => {
      const n = tc.draw(pooledName);
      const conditions = tc.draw(declared);
      expect(roleIn([{ kind: "with", name: n }], conditions)).not.toBe(roleIn([{ kind: "without", name: n }], conditions));
    }));

  it("are required exactly where the environment meets every tag, so required and control split the environments", () =>
    hegel.test((tc) => {
      const tags = tc.draw(gs.arrays(pooledTag, { maxSize: 4 }));
      const environments = tc.draw(gs.arrays(declared, { maxSize: 4 }));
      const required = environments.filter((conditions) => roleIn(tags, conditions) === "required");
      const control = environments.filter((conditions) => roleIn(tags, conditions) === "control");
      expect(required.length + control.length).toBe(environments.length);
      for (const conditions of required) expect(tags.every((tag) => meets(tag, conditions))).toBe(true);
      for (const conditions of control) expect(tags.some((tag) => !meets(tag, conditions))).toBe(true);
    }));

  it("never turn a control into a required cell when a tag is added", () =>
    hegel.test((tc) => {
      const tags = tc.draw(gs.arrays(pooledTag, { maxSize: 3 }));
      const extra = tc.draw(pooledTag);
      const conditions = tc.draw(declared);
      if (roleIn(tags, conditions) === "control") expect(roleIn([...tags, extra], conditions)).toBe("control");
    }));

  it("read an undeclared condition as off, and a value only where it is that string", () => {
    expect(meets({ kind: "with", name: "a" }, {})).toBe(false);
    expect(meets({ kind: "without", name: "a" }, undefined)).toBe(true);
    expect(meets({ kind: "with", name: "a" }, { a: "ja" })).toBe(true);
    expect(meets({ kind: "with-value", name: "a", value: "ja" }, { a: "ja" })).toBe(true);
    expect(meets({ kind: "with-value", name: "a", value: "true" }, { a: true })).toBe(false);
  });
});

describe("the environments a run with no --env selects", () => {
  it("are every environment that declares conditions, in file order, and default otherwise", () => {
    expect(defaultEnvironmentNames(null)).toEqual(["default"]);
    expect(defaultEnvironmentNames({ environments: { staging: {} } } as never)).toEqual(["default"]);
    expect(
      defaultEnvironmentNames({
        environments: { staging: {}, "flag-off": { conditions: {} }, "flag-on": { conditions: { a: true } } },
      } as never),
    ).toEqual(["flag-off", "flag-on"]);
  });

  it("selects what defaultEnvironments names, in its order, whatever the environments declare", () =>
    hegel.test((tc) => {
      const environments = Object.fromEntries(
        tc.draw(gs.arrays(gs.tuples(gs.sampledFrom(["staging", "flag-off", "flag-on", "preview"]), gs.booleans()), { maxSize: 4 })).map(([key, declares]) => [key, declares ? { conditions: { a: true } } : {}]),
      );
      const named = tc.draw(gs.arrays(gs.sampledFrom(["default", ...Object.keys(environments)]), { minSize: 1, maxSize: 3, unique: true }));
      expect(defaultEnvironmentNames({ environments, defaultEnvironments: named } as never)).toEqual(named);
    }));
});
