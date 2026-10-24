import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import type { ProgramRecipe, TimedCommand } from "../src/config/program-schema.js";
import {
  fillPlaceholders,
  PLACEHOLDER_NAMES,
  placeholderGaps,
  placeholderRefusal,
  type PlaceholderName,
  type PlaceholderValues,
} from "../src/program/placeholders.js";

// Responsibility: src/program/placeholders.ts, the one rule that fills
// `{port}`, `{url}`, `{dir}`, `{root}`, `{world}`, and `{token}` in a
// program file's commands and env, and names each one a world has no
// value for from its recipe alone.

// Literal text, braces included. Its alphabet cannot spell a placeholder
// name, so two pieces side by side never spell one between them.
const literal = gs.text({ alphabet: "ab {}:/-", maxSize: 6 });
const placeholder = gs.sampledFrom(PLACEHOLDER_NAMES);
// A value cannot spell a placeholder either, so the expected text is the
// pieces joined.
const value = gs.text({ alphabet: "xyz0189:/._-", maxSize: 8 });

describe("fillPlaceholders", () => {
  it("replaces every placeholder with its value and leaves the text between them as written", () =>
    hegel.test((tc) => {
      const pieces = tc.draw(gs.arrays(gs.tuples(literal, placeholder), { maxSize: 4 }));
      const tail = tc.draw(literal);
      const values = Object.fromEntries(PLACEHOLDER_NAMES.map((name) => [name, tc.draw(value)])) as Record<PlaceholderName, string>;
      const text = `${pieces.map(([before, name]) => `${before}{${name}}`).join("")}${tail}`;
      const expected = `${pieces.map(([before, name]) => `${before}${values[name]}`).join("")}${tail}`;
      expect(fillPlaceholders(text, values)).toEqual({ text: expected });
    }));

  it("leaves text with no placeholder unchanged, a JSON object or a shell brace included", () =>
    hegel.test((tc) => {
      const text = tc.draw(literal);
      expect(fillPlaceholders(text, {})).toEqual({ text });
    }));

  it("names the first placeholder that has no value, and never fills it with an empty string", () =>
    hegel.test((tc) => {
      const names = tc.draw(gs.arrays(placeholder, { minSize: 1, maxSize: 4 }));
      const known = new Set(tc.draw(gs.arrays(placeholder, { maxSize: 6 })));
      const values = Object.fromEntries([...known].map((name) => [name, "v"]));
      const text = names.map((name) => `-{${name}}`).join(" ");
      const firstMissing = names.find((name) => !known.has(name));
      expect(fillPlaceholders(text, values)).toEqual(
        firstMissing === undefined ? { text: names.map(() => "-v").join(" ") } : { missing: firstMissing },
      );
    }));

  it("fills an exact example", () => {
    expect(fillPlaceholders("bin/rails server -p {port} --pid {dir}/server.pid {other}", { port: "41873", dir: "/w" })).toEqual({
      text: "bin/rails server -p 41873 --pid /w/server.pid {other}",
    });
    expect(fillPlaceholders("{url}/up", {})).toEqual({ missing: "url" });
  });
});

// A world of each kind, as `placeholderGaps` reads it.
const reachKind = gs.sampledFrom(["serve", "url", "none"] as const);
const reachOf = (kind: "serve" | "url" | "none"): ProgramRecipe["reach"] =>
  kind === "serve"
    ? { kind, serve: { command: "node server.js", port: "auto", ready: "/", timeout_ms: 60_000 } }
    : kind === "url"
      ? { kind, url: "http://a.example", timeout_ms: 60_000 }
      : { kind };
// A command as a recipe holds it, with its limit.
const timed = (command: string | readonly string[]): TimedCommand => ({ command, timeout_ms: 600_000 });
// The values a running world of `kind` fills, and a build's.
function valuesFor(kind: "serve" | "url" | "none" | "build"): PlaceholderValues {
  if (kind === "build") return { root: "/r" };
  return { root: "/r", dir: "/d", world: "w", token: "t", ...(kind === "serve" ? { port: "1" } : {}), ...(kind === "none" ? {} : { url: "u" }) };
}
const word = gs.tuples(literal, gs.arrays(placeholder, { maxSize: 2 })).map(([text, names]) => `${text}${names.map((name) => `{${name}}`).join("")}`);
const command = gs.arrays(word, { minSize: 1, maxSize: 3 });

describe("placeholderGaps", () => {
  it("names a field exactly when filling it as a world of its kind would leaves a placeholder unfilled, first gap first", () =>
    hegel.test((tc) => {
      const kind = tc.draw(reachKind);
      const build = tc.draw(gs.arrays(command, { maxSize: 2 }));
      const prepare = tc.draw(gs.arrays(command, { maxSize: 2 }));
      const env = Object.fromEntries(tc.draw(gs.arrays(gs.tuples(gs.sampledFrom(["A", "B", "C"]), word), { maxSize: 3 })));
      const reach = reachOf(kind);
      const gaps = placeholderGaps({ build: build.map(timed), prepare: prepare.map(timed), reach, env });

      const fields: [string, readonly string[], "serve" | "url" | "none" | "build"][] = [
        ...build.map((words, index): [string, readonly string[], "build"] => [`build[${index}]`, words, "build"]),
        ...prepare.map((words, index): [string, readonly string[], typeof kind] => [`prepare[${index}]`, words, kind]),
        ...(kind === "serve" ? [["serve.command", ["node", "server.js"], kind] as [string, readonly string[], typeof kind]] : []),
        ...Object.entries(env).map(([key, value]): [string, readonly string[], typeof kind] => [`env.${key}`, [value], kind]),
      ];
      for (const [where, words, fieldKind] of fields) {
        const missing = words.map((text) => fillPlaceholders(text, valuesFor(fieldKind))).find((filled) => "missing" in filled);
        const own = gaps.filter((gap) => gap.where === where);
        expect(own.length > 0).toBe(missing !== undefined);
        if (missing !== undefined && "missing" in missing) expect(own[0]!.name).toBe(missing.missing);
        expect(new Set(own.map((gap) => gap.name)).size).toBe(own.length);
      }
      expect(gaps.every((gap) => fields.some(([where]) => where === gap.where))).toBe(true);
    }));

  it("names each gap of a program that serves nothing, and the refusal names every world's", () => {
    const recipe = { build: [timed(["node", "-e", "{root} {port}"])], prepare: [timed(["node", "-e", "x"]), timed("echo {port}")], reach: reachOf("url"), env: { BASE: "{url}" } };
    expect(placeholderGaps(recipe)).toEqual([
      { where: "build[0]", name: "port", why: "build runs once per tree, before any world exists" },
      { where: "prepare[1]", name: "port", why: "this world does not serve" },
    ]);
    expect(placeholderGaps({ ...recipe, build: [], reach: reachOf("none") })).toEqual([
      { where: "prepare[1]", name: "port", why: "this world does not serve" },
      { where: "env.BASE", name: "url", why: "this world has neither serve nor url" },
    ]);
    expect(placeholderRefusal([{ name: "default", recipe }, { name: "local", recipe: { ...recipe, reach: reachOf("serve") } }], "nukadoko.program.ts")).toEqual({
      message:
        "world default: build[0] names {port}, which has no value here: build runs once per tree, before any world exists; " +
        "world default: prepare[1] names {port}, which has no value here: this world does not serve; " +
        "world local: build[0] names {port}, which has no value here: build runs once per tree, before any world exists; nothing ran",
      fix: "Write only {root} in build[0] of nukadoko.program.ts, or move the command to prepare, which runs once per world.",
    });
    expect(placeholderRefusal([{ name: "local", recipe: { ...recipe, build: [], reach: reachOf("serve") } }], "nukadoko.program.ts")).toBeUndefined();
  });
});
