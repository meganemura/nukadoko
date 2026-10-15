import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { unseededRandomCalls } from "../src/check/unseeded-random.js";

// Responsibility: the scanner names a direct Math.random or crypto.random*
// call, and stays silent for the same text in a string, a template's text,
// a comment, or a regular expression, and for a name the function binds.

const TEXT = gs.text({ maxSize: 20, alphabet: "Mathcrypo.random()UUID/*`'\"\\${} \n" });

describe("unseededRandomCalls", () => {
  it("names each direct call in order", () => {
    expect(
      unseededRandomCalls("(s) => ({ id: crypto.randomUUID(), n: Math.random () * globalThis.crypto.randomInt(3) })"),
    ).toEqual(["crypto.randomUUID()", "Math.random()", "crypto.randomInt()"]);
  });

  it("finds the call inside a template's ${} part", () => {
    expect(unseededRandomCalls("() => `a ${`b ${Math.random()}`} c`")).toEqual(["Math.random()"]);
  });

  it("stays silent for a member of another object, a reference, and a bound name", () => {
    expect(unseededRandomCalls("(s) => s.Math.random() + Math.floor(1) + [1].map(Math.random).length")).toEqual([]);
    expect(unseededRandomCalls("(state, crypto) => crypto.randomUUID()")).toEqual([]);
    expect(unseededRandomCalls("() => { const Math = { random: () => 1 }; return Math.random(); }")).toEqual([]);
  });

  it("stays silent for any text inside a string literal", () =>
    hegel.test((tc) => {
      const text = tc.draw(TEXT);
      expect(unseededRandomCalls(`(s) => ${JSON.stringify(text)}.length`)).toEqual([]);
    }));

  it("stays silent for any text inside a block comment or a line comment", () =>
    hegel.test((tc) => {
      const text = tc.draw(TEXT).replaceAll("*/", "").replaceAll("\n", " ");
      expect(unseededRandomCalls(`() => { /* ${text} */ return 1; // ${text}\n}`)).toEqual([]);
    }));

  it("stays silent for any text in a template's text part", () =>
    hegel.test((tc) => {
      const text = tc.draw(TEXT).replace(/[`\\$]/g, (char) => `\\${char}`);
      expect(unseededRandomCalls(`() => \`${text}\``)).toEqual([]);
    }));

  it("finds the one call after any string literal", () =>
    hegel.test((tc) => {
      const text = tc.draw(TEXT);
      expect(unseededRandomCalls(`() => ${JSON.stringify(text)} + Math.random()`)).toEqual(["Math.random()"]);
    }));

  it("stays silent for a regular expression that names the call", () => {
    expect(unseededRandomCalls("() => /Math.random()|crypto.randomUUID()/.test('x') && 4 / 2 > 1")).toEqual([]);
  });
});
