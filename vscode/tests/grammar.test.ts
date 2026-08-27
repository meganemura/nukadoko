// Responsibility: prove the two TextMate grammars this package ships
// (syntaxes/gherkin.tmLanguage.json and
// syntaxes/nukadoko-pattern-injection.tmLanguage.json) actually tokenize the
// constructs the README promises, using the same tokenizer VSCode itself
// runs (vscode-textmate + vscode-oniguruma), not a hand-rolled regex check
// that could pass while the shipped grammar file is broken.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as oniguruma from "vscode-oniguruma";
import { INITIAL, Registry, parseRawGrammar, type IRawGrammar } from "vscode-textmate";
import { beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const vscodeRoot = path.resolve(here, "..");
const gherkinGrammarPath = path.join(vscodeRoot, "syntaxes", "gherkin.tmLanguage.json");
const injectionGrammarPath = path.join(
  vscodeRoot,
  "syntaxes",
  "nukadoko-pattern-injection.tmLanguage.json",
);

const GHERKIN_SCOPE = "source.gherkin";
const INJECTION_SCOPE = "nukadoko.pattern-injection";

// A stand-in for `source.ts`, built in this test rather than loaded from a
// real TypeScript grammar file. `@types/vscode`'s own package does not ship
// one, and no package in this extension's dependency list ships a
// TextMate-format TypeScript grammar either -- the closest real one is the
// multi-thousand line grammar VSCode itself bundles. Adding a dependency
// here needs its own approval (exact-pinned, a release at least a week
// old), so this host grammar
// covers only the one thing the injection test needs from a real TypeScript
// grammar: a double-quoted string literal whose leaf scope is named
// `string.quoted.double.ts` (matching the injection's own
// `injectionSelector`), so the injection grammar under test loads and runs
// exactly as it would inside a real `source.ts` document.
const TS_STRING_HOST_SCOPE = "source.ts.embedded.nukadoko-pattern";
const tsStringHostGrammar: IRawGrammar = parseRawGrammar(
  JSON.stringify({
    scopeName: TS_STRING_HOST_SCOPE,
    patterns: [
      {
        begin: '"',
        end: '"',
        name: "string.quoted.double.ts",
      },
    ],
  }),
  "ts-string-host.tmLanguage.json",
);

async function loadOnigLib() {
  const wasmPath = path.join(vscodeRoot, "node_modules", "vscode-oniguruma", "release", "onig.wasm");
  const wasmBin = await readFile(wasmPath);
  await oniguruma.loadWASM(wasmBin.buffer as ArrayBuffer);
  return {
    createOnigScanner(patterns: string[]) {
      return new oniguruma.OnigScanner(patterns);
    },
    createOnigString(value: string) {
      return new oniguruma.OnigString(value);
    },
  };
}

async function readGrammarFile(grammarPath: string): Promise<IRawGrammar> {
  const content = await readFile(grammarPath, "utf8");
  return parseRawGrammar(content, grammarPath);
}

describe("gherkin.tmLanguage.json", () => {
  let registry: Registry;

  beforeAll(async () => {
    const onigLib = loadOnigLib();
    registry = new Registry({
      onigLib,
      loadGrammar: async (scopeName) => {
        if (scopeName === GHERKIN_SCOPE) {
          return readGrammarFile(gherkinGrammarPath);
        }
        return null;
      },
    });
  });

  async function tokenizeGherkinLine(line: string) {
    const grammar = await registry.loadGrammar(GHERKIN_SCOPE);
    if (!grammar) {
      throw new Error(`failed to load ${GHERKIN_SCOPE}`);
    }
    return grammar.tokenizeLine(line, INITIAL).tokens;
  }

  function scopesAt(tokens: { startIndex: number; endIndex: number; scopes: string[] }[], index: number) {
    const token = tokens.find((t) => index >= t.startIndex && index < t.endIndex);
    return token?.scopes ?? [];
  }

  it("scopes the Feature: keyword with a section keyword scope", async () => {
    const tokens = await tokenizeGherkinLine("Feature: Todo list");
    const scopes = scopesAt(tokens, "Feature".length - 1);
    expect(scopes).toContain("keyword.control.section.gherkin");
  });

  it("scopes Given as a step keyword and a quoted step argument as a string", async () => {
    const line = 'Given a todo titled "Buy milk" is added';
    const tokens = await tokenizeGherkinLine(line);
    const givenIndex = line.indexOf("Given");
    const stringIndex = line.indexOf("Buy milk");
    expect(scopesAt(tokens, givenIndex)).toContain("keyword.control.step.gherkin");
    expect(scopesAt(tokens, stringIndex)).toContain("string.quoted.double.gherkin");
  });

  it("scopes a @tag line with a tag scope", async () => {
    const tokens = await tokenizeGherkinLine("@smoke");
    const scopes = scopesAt(tokens, 0);
    expect(scopes).toContain("entity.name.tag.gherkin");
  });

  it("scopes a table row's | delimiters", async () => {
    const line = "  | Water the plants |";
    const tokens = await tokenizeGherkinLine(line);
    const firstPipe = line.indexOf("|");
    expect(scopesAt(tokens, firstPipe)).toContain("punctuation.definition.table.gherkin");
  });

  it("scopes a # comment", async () => {
    const tokens = await tokenizeGherkinLine("# a comment");
    const scopes = scopesAt(tokens, 0);
    expect(scopes).toContain("comment.line.number-sign.gherkin");
  });
});

describe("nukadoko-pattern-injection.tmLanguage.json", () => {
  let registry: Registry;

  beforeAll(async () => {
    const onigLib = loadOnigLib();
    registry = new Registry({
      onigLib,
      loadGrammar: async (scopeName) => {
        if (scopeName === TS_STRING_HOST_SCOPE) {
          return tsStringHostGrammar;
        }
        if (scopeName === INJECTION_SCOPE) {
          return readGrammarFile(injectionGrammarPath);
        }
        return null;
      },
      getInjections: (scopeName) => {
        if (scopeName === TS_STRING_HOST_SCOPE) {
          return [INJECTION_SCOPE];
        }
        return undefined;
      },
    });
  });

  it("scopes {title:string} inside a TypeScript double-quoted string via injection", async () => {
    const grammar = await registry.loadGrammar(TS_STRING_HOST_SCOPE);
    if (!grammar) {
      throw new Error(`failed to load ${TS_STRING_HOST_SCOPE}`);
    }
    const line = 'pattern: "a todo titled {title:string} is added"';
    const result = grammar.tokenizeLine(line, INITIAL);
    const captureIndex = line.indexOf("{title:string}") + 1;
    const token = result.tokens.find((t) => captureIndex >= t.startIndex && captureIndex < t.endIndex);
    expect(token?.scopes).toContain("meta.capture.nukadoko");
    expect(token?.scopes).toContain("string.quoted.double.ts");
  });
});
