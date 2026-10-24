import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { type EnvDifference, envDifference } from "../src/context/env-difference.js";
import { recordedEnv } from "../src/context/run-command.js";
import type { EnvValue } from "../src/record/types.js";

// Responsibility: the environment a `runCommand` process got, written as
// its difference from the runner's (src/context/env-difference.ts), and
// the values the record may show (`recordedEnv` in
// src/context/run-command.ts). The difference round-trips: the runner's
// environment with the difference applied is the environment the process
// got, so it loses nothing and invents nothing. The record then shows a
// value only when it is an absolute path that exists, a decimal integer,
// or a boolean, and gives every other value as its UTF-8 byte length.

const name = gs.sampledFrom(["HOME", "PATH", "TOKEN", "LANG", "CI", "PORT"]);
const value = gs.optional(gs.sampledFrom(["", "1", "on", "/usr/bin", "x y"]));
const env = gs.maps(name, value, { maxSize: 6 }).map((entries) => Object.fromEntries(entries) as NodeJS.ProcessEnv);

function applied(runner: NodeJS.ProcessEnv, difference: EnvDifference): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, each] of Object.entries(runner)) if (each !== undefined) result[key] = each;
  if ("inherited" in difference) return result;
  for (const key of difference.removed) delete result[key];
  return { ...result, ...difference.added, ...difference.changed };
}

function defined(given: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(given).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

describe("envDifference", () => {
  it("round-trips: the runner's environment with the difference applied is the one given", () =>
    hegel.test((tc) => {
      const runner = tc.draw(env);
      const given = tc.draw(env);
      expect(applied(runner, envDifference(runner, given))).toEqual(defined(given));
    }));

  it("names each variable in one list only, in sorted order", () =>
    hegel.test((tc) => {
      const difference = envDifference(tc.draw(env), tc.draw(env));
      if ("inherited" in difference) return;
      const names = [...Object.keys(difference.added), ...Object.keys(difference.changed), ...difference.removed];
      expect(new Set(names).size).toBe(names.length);
      for (const list of [Object.keys(difference.added), Object.keys(difference.changed), difference.removed]) {
        expect(list).toEqual([...list].sort());
      }
    }));

  it("says inherited when the step passed no environment, or the runner's own", () => {
    const runner = { PATH: "/usr/bin" };
    expect(envDifference(runner, undefined)).toEqual({ inherited: true });
    expect(envDifference(runner, runner)).toEqual({ inherited: true });
  });
});

// A stand-in for the file system: half of all path-shaped values exist.
function exists(path: string): boolean {
  return path.length % 2 === 0;
}

// The three kinds of value the record may show, written apart from the
// module's own patterns so the property checks the rule and not the
// regular expressions.
function isShown(value: string): boolean {
  const absolute = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
  const printable = [...value].every((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f);
  const integer = /^-?[0-9]+$/.test(value);
  return (absolute && printable && exists(value)) || integer || value === "true" || value === "false";
}

const recordedValue = gs.oneOf(
  gs.text({ maxSize: 40 }),
  gs.fromRegex("(/|[A-Za-z]:[\\\\/])[^\\n]{0,20}", { fullmatch: true }),
  gs.integers({ minValue: -1_000_000, maxValue: 1_000_000 }).map(String),
  gs.sampledFrom(["true", "false", "TRUE", "yes", "", "ghp_0123456789abcdef", "Bearer abc", "/usr/bin\nTOKEN=x"]),
);
const recordedValues = gs.maps(name, recordedValue, { maxSize: 6 }).map((entries) => Object.fromEntries(entries) as Record<string, string>);

function eachRecorded(record: Readonly<Record<string, EnvValue>>, given: Readonly<Record<string, string>>): void {
  expect(Object.keys(record)).toEqual(Object.keys(given));
  for (const [key, value] of Object.entries(record)) {
    const original = given[key]!;
    if (typeof value === "string") {
      expect(isShown(value)).toBe(true);
      expect(value).toBe(original);
    } else {
      expect(isShown(original)).toBe(false);
      expect(value).toEqual({ hidden_bytes: Buffer.byteLength(original, "utf8") });
    }
  }
}

describe("recordedEnv", () => {
  it("shows only a path that exists, an integer, or a boolean, and gives every other value its byte length", () =>
    hegel.test((tc) => {
      const added = tc.draw(recordedValues);
      const changed = tc.draw(recordedValues);
      const removed = tc.draw(gs.arrays(name, { maxSize: 3 }));
      const record = recordedEnv({ added, changed, removed }, [], exists);
      if ("inherited" in record) throw new Error("a difference stays a difference");
      eachRecorded(record.added, added);
      eachRecorded(record.changed, changed);
      expect(record.removed).toEqual(removed);
    }));

  it("keeps every name, hides a token the step passed itself, and redacts a secret in a shown value", () => {
    const present = new Set(["/home/runner-secret", "C:\\Tools"]);
    const record = recordedEnv(
      {
        added: {
          API_TOKEN: "ghp_0123456789abcdef",
          SIGNING_KEY: "/q8Zx+Lr0aW==",
          HOME: "/home/runner-secret",
          PORT: "8080",
          CI: "true",
          WIN: "C:\\Tools",
          EMPTY: "",
        },
        changed: { LANG: "ja_JP.UTF-8" },
        removed: ["AWS_SECRET_ACCESS_KEY"],
      },
      [{ name: "RUNNER", value: "runner-secret" }],
      (path) => present.has(path),
    );
    expect(record).toEqual({
      added: {
        API_TOKEN: { hidden_bytes: 20 },
        SIGNING_KEY: { hidden_bytes: 13 },
        HOME: "/home/{{secret.RUNNER}}",
        PORT: "8080",
        CI: "true",
        WIN: "C:\\Tools",
        EMPTY: { hidden_bytes: 0 },
      },
      changed: { LANG: { hidden_bytes: 11 } },
      removed: ["AWS_SECRET_ACCESS_KEY"],
    });
  });

  it("counts bytes, not characters", () => {
    expect(recordedEnv({ added: { NAME: "é" }, changed: {}, removed: [] }, [])).toEqual({
      added: { NAME: { hidden_bytes: 2 } },
      changed: {},
      removed: [],
    });
  });

  it("leaves an inherited environment as it is", () => {
    expect(recordedEnv({ inherited: true }, [])).toEqual({ inherited: true });
  });
});
