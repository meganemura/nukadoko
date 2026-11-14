import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseEnvFile, skippedEnvFileLines } from "../src/env/parse-env-file.js";

// Responsibility: the env-file parser is a pure function from text to a
// string map. The examples are the inputs a dotenv file actually contains
// (a trailing comment, quotes, backslash escapes, a value that spans
// lines). The property is the one a single example cannot state: joining
// the same bindings with LF or CRLF, and placing "=" inside a value, does
// not change the map.

const keyGen = gs.text({ alphabet: "abcXYZ_", minSize: 1, maxSize: 8 });
const piece = gs.text({ alphabet: "abcXYZ012=-_", minSize: 0, maxSize: 12 });

interface Binding {
  readonly key: string;
  readonly value: string;
}

function bindingLine(binding: Binding): string {
  if (binding.value.includes("\n")) {
    return `${binding.key}="${binding.value}"`;
  }
  return `${binding.key}=${binding.value}`;
}

function serialize(bindings: readonly Binding[], eol: "\n" | "\r\n"): string {
  const lf = bindings.map(bindingLine).join("\n");
  return eol === "\r\n" ? lf.replaceAll("\n", "\r\n") : lf;
}

describe("parseEnvFile", () => {
  it("strips an inline comment from an unquoted value", () => {
    expect(parseEnvFile("TOKEN=abc123 # rotated")).toEqual({ TOKEN: "abc123" });
  });

  it("strips quotes and a trailing comment", () => {
    expect(parseEnvFile('KEY="a" # note')).toEqual({ KEY: "a" });
    expect(parseEnvFile("KEY='a' # note")).toEqual({ KEY: "a" });
    expect(parseEnvFile("KEY=`a` # note")).toEqual({ KEY: "a" });
  });

  it("expands newline and carriage-return escapes in double quotes only", () => {
    expect(parseEnvFile('KEY="line1\\nline2"')).toEqual({ KEY: "line1\nline2" });
    expect(parseEnvFile('KEY="a\\r\\nb"')).toEqual({ KEY: "a\r\nb" });
    expect(parseEnvFile("KEY='line1\\nline2'")).toEqual({ KEY: "line1\\nline2" });
    expect(parseEnvFile("KEY=`line1\\nline2`")).toEqual({ KEY: "line1\\nline2" });
  });

  it("keeps a closed quote that spans lines as one value", () => {
    const content = [
      'KEY="-----BEGIN PRIVATE KEY-----',
      "MIIE",
      "abcDEF=",
      '-----END PRIVATE KEY-----"',
      "NEXT=ok",
    ].join("\n");
    expect(parseEnvFile(content)).toEqual({
      KEY: "-----BEGIN PRIVATE KEY-----\nMIIE\nabcDEF=\n-----END PRIVATE KEY-----",
      NEXT: "ok",
    });
  });

  it("treats backticks as quotes", () => {
    expect(parseEnvFile("KEY=`backtick`")).toEqual({ KEY: "backtick" });
  });

  it("keeps an unclosed quote as ordinary text on that line", () => {
    expect(parseEnvFile('KEY="unterminated')).toEqual({ KEY: '"unterminated' });
    expect(parseEnvFile('KEY="unterminated\nNEXT=ok')).toEqual({
      KEY: '"unterminated',
      NEXT: "ok",
    });
  });

  it("keeps equals signs that are part of the value", () => {
    expect(parseEnvFile("FOO=bar=baz")).toEqual({ FOO: "bar=baz" });
    expect(parseEnvFile('FOO="bar=baz"')).toEqual({ FOO: "bar=baz" });
  });

  it("lets a later binding replace an earlier one", () => {
    expect(parseEnvFile("DUP=1\nDUP=2")).toEqual({ DUP: "2" });
  });

  it("accepts an export prefix and whitespace around the separator", () => {
    expect(parseEnvFile("export   KEY=value")).toEqual({ KEY: "value" });
    expect(parseEnvFile("FOO = bar")).toEqual({ FOO: "bar" });
    expect(parseEnvFile("export=value")).toEqual({ export: "value" });
  });

  it("does not expand $ references", () => {
    expect(parseEnvFile("KEY=$OTHER")).toEqual({ KEY: "$OTHER" });
    expect(parseEnvFile('KEY="$OTHER"')).toEqual({ KEY: "$OTHER" });
  });

  it("expands a doubled backslash-n the way dotenv does", () => {
    expect(parseEnvFile('KEY="\\\\n"')).toEqual({ KEY: "\\\n" });
  });

  it("keeps an escaped quote inside a double-quoted value", () => {
    expect(parseEnvFile('KEY="say \\"hi\\""')).toEqual({ KEY: 'say \\"hi\\"' });
  });

  it("names a line that is not a binding, including in a CRLF file", () => {
    expect(skippedEnvFileLines("# c\r\nNOT A BINDING\r\nFOO=1\r\n")).toEqual([2]);
    expect(skippedEnvFileLines("=nope\nOK=1\n")).toEqual([1]);
    expect(skippedEnvFileLines("KEY: value\n")).toEqual([1]);
  });

  it("parses the same bindings whether lines are joined with LF or CRLF", () =>
    hegel.test((tc) => {
      const singles = tc.draw(gs.arrays(gs.tuples(keyGen, piece), { minSize: 0, maxSize: 4 })).map(
        ([key, value]) => ({ key, value }),
      );
      const [eqKey, eqLeft, eqRight] = tc.draw(gs.tuples(keyGen, piece, piece));
      const [multiKey, multiLeft, multiRight] = tc.draw(gs.tuples(keyGen, piece, piece));
      const bindings: Binding[] = [
        ...singles,
        { key: `E_${eqKey}`, value: `${eqLeft}=${eqRight}` },
        { key: `M_${multiKey}`, value: `${multiLeft}\n${multiRight}` },
      ];
      const expected: Record<string, string> = {};
      for (const binding of bindings) {
        expected[binding.key] = binding.value;
      }
      const lf = parseEnvFile(serialize(bindings, "\n"));
      const crlf = parseEnvFile(serialize(bindings, "\r\n"));
      expect(lf).toEqual(crlf);
      expect(lf).toEqual(expected);
    }));
});
