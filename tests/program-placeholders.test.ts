import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { fillPlaceholders, PLACEHOLDER_NAMES, type PlaceholderName } from "../src/program/placeholders.js";

// Responsibility: src/program/placeholders.ts, the one rule that fills
// `{port}`, `{url}`, `{dir}`, `{root}`, `{world}`, and `{token}` in a
// program file's commands and env.

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
