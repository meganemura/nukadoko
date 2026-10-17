import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  appendCompilerOption,
  appendIncludeEntries,
  includeMayCover,
  missingIncludeEntries,
  needsTsExtensionOption,
  parseJsonc,
  tsExtensionImportsAccepted,
} from "../src/cli/tsconfig-edit.js";

// Responsibility: the pure half of `nuka init`'s tsconfig.json edit and
// hint. The JSONC reader must give back what JSON.parse gives for the same
// value with comments and trailing commas around it, the coverage rule must
// never claim a path is left out when an entry could reach it, and the
// in-place append must leave every byte outside the include array alone.
// The compiler option edit holds to the same rule for compilerOptions.

const segment = gs.fromRegex("[a-z]{1,6}", { fullmatch: true });
const literalPaths = gs.arrays(segment, { minSize: 1, maxSize: 4 }).map((parts) => parts.join("/"));
const jsonStrings = gs.text({ maxSize: 12 });
const jsonValues = gs.oneOf<unknown>(
  gs.arrays(jsonStrings, { maxSize: 4 }),
  gs.record({ include: gs.arrays(jsonStrings, { maxSize: 4 }), name: jsonStrings }),
);

describe("parseJsonc", () => {
  it("reads a value back from its JSON text with a comment after every line and a trailing comma", () =>
    hegel.test((tc) => {
      const value = tc.draw(jsonValues);
      const lines = JSON.stringify(value, null, 2).split("\n");
      const commented = lines
        .map((line, index) => {
          const closes = /^\s*[\]}]/.test(lines[index + 1] ?? "");
          const withComma = closes && !/[[{]$/.test(line) ? `${line},` : line;
          return `${withComma} // note "quoted" /* not a block */`;
        })
        .join("\n");
      expect(parseJsonc(`/* head */\n${commented}\n`)).toEqual(value);
    }));

  it("keeps // and /* inside a string", () => {
    expect(parseJsonc('{ "$schema": "https://example.com/a/*b*/", }')).toEqual({
      $schema: "https://example.com/a/*b*/",
    });
  });
});

describe("includeMayCover", () => {
  it("a literal entry covers a path exactly when it is that path or one of its directories", () =>
    hegel.test((tc) => {
      const target = tc.draw(literalPaths);
      const entry = tc.draw(literalPaths);
      const covers = target === entry || target.startsWith(`${entry}/`);
      expect(includeMayCover(entry, target)).toBe(covers);
      expect(includeMayCover(`./${entry}`, target)).toBe(covers);
    }));

  it("an entry whose first wildcard follows a matching prefix always covers", () =>
    hegel.test((tc) => {
      const target = tc.draw(literalPaths);
      const parts = target.split("/");
      const keep = tc.draw(gs.integers({ minValue: 0, maxValue: parts.length - 1 }));
      const wildcard = tc.draw(gs.sampledFrom(["**", "*", "*.ts", "**/*"]));
      const entry = [...parts.slice(0, keep), wildcard].join("/");
      expect(includeMayCover(entry, target)).toBe(true);
    }));
});

describe("missingIncludeEntries", () => {
  it("names the features glob and the config file, in that order, for an include that reaches neither", () => {
    expect(missingIncludeEntries(["src", "test/**/*.ts"], "features", "nukadoko.config.ts")).toEqual([
      "features/**/*",
      "nukadoko.config.ts",
    ]);
  });

  it("names nothing once the entries it named are added", () =>
    hegel.test((tc) => {
      const include = tc.draw(gs.arrays(literalPaths, { maxSize: 4 }));
      const featuresDir = tc.draw(literalPaths);
      const configFileName = tc.draw(gs.sampledFrom(["nukadoko.config.ts", "nukadoko.config.mts"]));
      const missing = missingIncludeEntries(include, featuresDir, configFileName);
      expect(missingIncludeEntries([...include, ...missing], featuresDir, configFileName)).toEqual([]);
    }));
});

describe("appendIncludeEntries", () => {
  it("follows a one-line array's separator", () => {
    expect(appendIncludeEntries('{"include":["src","test"]}', ["features/**/*"])).toBe(
      '{"include":["src","test","features/**/*"]}',
    );
    expect(appendIncludeEntries('{ "include": ["src"] }', ["a", "b"])).toBe('{ "include": ["src", "a", "b"] }');
  });

  it("fills an empty array on one line", () => {
    expect(appendIncludeEntries('{\n  "include": [\n  ]\n}\n', ["a", "b"])).toBe('{\n  "include": ["a", "b"]\n}\n');
  });

  it("keeps CRLF line endings in a multi-line array", () => {
    expect(appendIncludeEntries('{\r\n  "include": [\r\n    "src"\r\n  ]\r\n}\r\n', ["a"])).toBe(
      '{\r\n  "include": [\r\n    "src",\r\n    "a"\r\n  ]\r\n}\r\n',
    );
  });

  it("edits the top-level include, not a nested key of the same name", () => {
    expect(appendIncludeEntries('{"watchOptions":{"include":["x"]},"include":["src"]}', ["a"])).toBe(
      '{"watchOptions":{"include":["x"]},"include":["src", "a"]}',
    );
  });

  // The property `nuka init` relies on: after the append, nothing is left
  // to add, the original entries come first and in order, every other key
  // is unchanged, and the text outside the array is the same bytes.
  const includeEntries = gs.oneOf(
    literalPaths,
    literalPaths.map((entry) => `${entry}/**/*`),
    gs.sampledFrom(["**/*", "*.ts", "features/**", "nukadoko.config.ts"]),
  );
  it("leaves no missing entry, keeps the original entries in order, and changes nothing outside the array", () =>
    hegel.test((tc) => {
      const include = tc.draw(gs.arrays(includeEntries, { maxSize: 5 }));
      const featuresDir = tc.draw(literalPaths);
      const configFileName = tc.draw(gs.sampledFrom(["nukadoko.config.ts", "nukadoko.config.mts"]));
      const tsconfig = {
        compilerOptions: { strict: true, paths: { "#x": ["./x/*"] } },
        include,
        exclude: ["dist"],
      };
      const indent = tc.draw(gs.sampledFrom<string | undefined>([undefined, "  ", "    ", "\t"]));
      const text = `${JSON.stringify(tsconfig, null, indent)}${tc.draw(gs.sampledFrom(["", "\n"]))}`;
      const missing = missingIncludeEntries(include, featuresDir, configFileName);

      const edited = appendIncludeEntries(text, missing);

      const parsed = JSON.parse(edited) as typeof tsconfig;
      expect(missingIncludeEntries(parsed.include, featuresDir, configFileName)).toEqual([]);
      expect(parsed).toEqual({ ...tsconfig, include: [...include, ...missing] });
      const before = text.slice(0, text.indexOf('"include"'));
      const after = text.slice(text.indexOf('"exclude"') - 1);
      expect(edited.startsWith(before)).toBe(true);
      expect(edited.endsWith(after)).toBe(true);
    }));
});

// What `tsc --init` (TypeScript 6.0.3) writes, with an `include` added: the
// JSONC dialect most projects start from.
const tscInitWithInclude = `{
  // Visit https://aka.ms/tsconfig to read more about this file
  "compilerOptions": {
    // File Layout
    // "rootDir": "./src",
    // "outDir": "./dist",

    // Environment Settings
    // See also https://aka.ms/tsconfig/module
    "module": "nodenext",
    "target": "esnext",
    "types": [],
    // For nodejs:
    // "lib": ["esnext"],
    // "types": ["node"],
    // and npm install -D @types/node

    // Other Outputs
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,

    // Stricter Typechecking Options
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,

    // Style Options
    // "noImplicitReturns": true,
    // "noImplicitOverride": true,
    // "noUnusedLocals": true,
    // "noUnusedParameters": true,
    // "noFallthroughCasesInSwitch": true,
    // "noPropertyAccessFromIndexSignature": true,

    // Recommended Options
    "strict": true,
    "jsx": "react-jsx",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedSideEffectImports": true,
    "moduleDetection": "force",
    "skipLibCheck": true,
  },
  "include": ["src"],
}
`;

describe("appendIncludeEntries on JSONC", () => {
  it("adds the entries to a tsc --init file and leaves every other byte alone", () => {
    expect(appendIncludeEntries(tscInitWithInclude, ["features/**/*", "nukadoko.config.ts"])).toBe(
      tscInitWithInclude.replace('"include": ["src"],', '"include": ["src", "features/**/*", "nukadoko.config.ts"],'),
    );
  });

  it("does not take a [ or an include key inside a // comment for the array", () => {
    const text = '{\n  // "include": [ "old" ]\n  "include": [\n    "src" // [ "x" ]\n  ]\n}\n';
    expect(appendIncludeEntries(text, ["a"])).toBe(
      '{\n  // "include": [ "old" ]\n  "include": [\n    "src", // [ "x" ]\n    "a"\n  ]\n}\n',
    );
  });

  it("finds the array past a /* */ comment between the key and the [", () => {
    expect(appendIncludeEntries('{ "include": /* sources */ ["src"] }', ["a"])).toBe(
      '{ "include": /* sources */ ["src", "a"] }',
    );
  });

  it("keeps a trailing comma after the last element of a multi-line array", () => {
    expect(appendIncludeEntries('{\n  "include": [\n    "src",\n  ],\n}\n', ["a", "b"])).toBe(
      '{\n  "include": [\n    "src",\n    "a",\n    "b",\n  ],\n}\n',
    );
  });

  it("keeps a trailing comma in a one-line array", () => {
    expect(appendIncludeEntries('{ "include": ["src",], }', ["a", "b"])).toBe('{ "include": ["src", "a", "b",], }');
    expect(appendIncludeEntries('{ "include": ["src", ] }', ["a"])).toBe('{ "include": ["src", "a", ] }');
  });

  it("keeps CRLF line endings and the comment that ends the last element's line", () => {
    expect(appendIncludeEntries('{\r\n  "include": [\r\n    "src", // mine\r\n  ],\r\n}\r\n', ["a"])).toBe(
      '{\r\n  "include": [\r\n    "src", // mine\r\n    "a",\r\n  ],\r\n}\r\n',
    );
  });

  it("fills an array that holds only a comment, and keeps the comment", () => {
    expect(appendIncludeEntries('{ "include": [ /* none yet */ ] }', ["a"])).toBe('{ "include": ["a" /* none yet */ ] }');
  });

  // Whitespace and comments in every gap a token boundary allows, chosen to
  // hold the characters the scanner must not take for structure.
  const gaps = gs.sampledFrom([
    "",
    " ",
    "\n  ",
    "\r\n\t",
    ' // "include": [ "x", ]\n',
    "\n  // a, b ]\n  ",
    ' /* "include": [ */ ',
    "/* a\n ] */",
  ]);
  it("appends the entries to the parsed include and keeps the text outside the brackets, for any JSONC layout", () =>
    hegel.test((tc) => {
      const gap = () => tc.draw(gaps);
      const comma = () => (tc.draw(gs.booleans()) ? `,${gap()}` : "");
      const list = (items: readonly string[], open: string, close: string): string =>
        items.length === 0
          ? `${open}${gap()}${close}`
          : `${open}${gap()}${items.join(`${gap()},${gap()}`)}${gap()}${comma()}${close}`;
      const include = tc.draw(gs.arrays(jsonStrings, { maxSize: 4 }));
      const exclude = tc.draw(gs.arrays(jsonStrings, { maxSize: 2 }));
      const entries = tc.draw(gs.arrays(literalPaths, { minSize: 1, maxSize: 2 }));
      const member = (key: string, value: string) => `${JSON.stringify(key)}${gap()}:${gap()}${value}`;
      const prefix = `${gap()}{${gap()}${member("compilerOptions", list([member("strict", "true")], "{", "}"))}${gap()},${gap()}"include"${gap()}:${gap()}`;
      const array = list(include.map((entry) => JSON.stringify(entry)), "[", "]");
      const suffix = `${gap()},${gap()}${member("exclude", list(exclude.map((entry) => JSON.stringify(entry)), "[", "]"))}${gap()}${comma()}}${gap()}`;
      const text = `${prefix}${array}${suffix}`;

      const edited = appendIncludeEntries(text, entries);

      expect(parseJsonc(edited)).toEqual({
        compilerOptions: { strict: true },
        include: [...include, ...entries],
        exclude,
      });
      expect(edited.startsWith(`${prefix}[`)).toBe(true);
      expect(edited.endsWith(`]${suffix}`)).toBe(true);
    }));
});

describe("needsTsExtensionOption", () => {
  it("asks for the option only when compilerOptions is an object that names neither option", () => {
    expect(needsTsExtensionOption({ compilerOptions: { strict: true } })).toBe(true);
    expect(needsTsExtensionOption({ compilerOptions: {} })).toBe(true);
    expect(needsTsExtensionOption({ compilerOptions: { rewriteRelativeImportExtensions: false } })).toBe(false);
    expect(needsTsExtensionOption({ compilerOptions: { allowImportingTsExtensions: true } })).toBe(false);
    expect(needsTsExtensionOption({ extends: "./tsconfig.base.json" })).toBe(false);
    expect(needsTsExtensionOption({ compilerOptions: [] })).toBe(false);
    expect(needsTsExtensionOption({ compilerOptions: null })).toBe(false);
    expect(needsTsExtensionOption([])).toBe(false);
  });
});

describe("appendCompilerOption", () => {
  it("adds the option after the last member of a one-line and a multi-line object", () => {
    expect(appendCompilerOption('{ "compilerOptions": { "strict": true } }', "rewriteRelativeImportExtensions")).toBe(
      '{ "compilerOptions": { "strict": true, "rewriteRelativeImportExtensions": true } }',
    );
    expect(appendCompilerOption('{\n  "compilerOptions": {\n    "strict": true, // on\n  }\n}\n', "x")).toBe(
      '{\n  "compilerOptions": {\n    "strict": true, // on\n    "x": true,\n  }\n}\n',
    );
    expect(appendCompilerOption('{ "compilerOptions": {} }', "x")).toBe('{ "compilerOptions": {"x": true} }');
  });

  const gaps = gs.sampledFrom(["", " ", "\n    ", "\r\n\t", ' // "compilerOptions": { }\n', ' /* } */ ']);
  it("adds the option to the parsed compilerOptions and keeps the text outside its braces, for any JSONC layout", () =>
    hegel.test((tc) => {
      const gap = () => tc.draw(gaps);
      const keys = tc.draw(gs.arrays(gs.fromRegex("[a-z]{1,8}", { fullmatch: true }), { maxSize: 4, unique: true }));
      const members = keys.map((key) => `${JSON.stringify(key)}${gap()}:${gap()}true`);
      const trailing = members.length > 0 && tc.draw(gs.booleans()) ? `,${gap()}` : "";
      const object = `{${gap()}${members.join(`${gap()},${gap()}`)}${gap()}${trailing}}`;
      const prefix = `{${gap()}"include"${gap()}:${gap()}["src"]${gap()},${gap()}"compilerOptions"${gap()}:${gap()}`;
      const suffix = `${gap()}}${gap()}`;

      const edited = appendCompilerOption(`${prefix}${object}${suffix}`, "rewriteRelativeImportExtensions");

      expect(parseJsonc(edited)).toEqual({
        include: ["src"],
        compilerOptions: { ...Object.fromEntries(keys.map((key) => [key, true])), rewriteRelativeImportExtensions: true },
      });
      expect(edited.startsWith(`${prefix}{`)).toBe(true);
      expect(edited.endsWith(`}${suffix}`)).toBe(true);
    }));
});

describe("tsExtensionImportsAccepted", () => {
  function accepted(files: Record<string, string>): boolean | undefined {
    const dir = mkdtempSync(path.join(tmpdir(), "nuka-ts-ext-"));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
      return tsExtensionImportsAccepted(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("answers from the value where TypeScript takes it: the file's own options, then the last base that sets it", () => {
    expect(accepted({})).toBe(undefined);
    expect(accepted({ "tsconfig.json": '{ "compilerOptions": { "module": "nodenext" } }' })).toBe(false);
    expect(accepted({ "tsconfig.json": '{ "compilerOptions": { "rewriteRelativeImportExtensions": true } }' })).toBe(true);
    expect(accepted({ "tsconfig.json": '{ "compilerOptions": { "allowImportingTsExtensions": true, "noEmit": true } }' })).toBe(true);
    expect(accepted({ "tsconfig.json": '{ "compilerOptions": { "rewriteRelativeImportExtensions": false } }' })).toBe(false);
    expect(
      accepted({
        "base.json": '{ "compilerOptions": { "rewriteRelativeImportExtensions": true } }',
        "tsconfig.json": '// comment\n{ "extends": "./base", }',
      }),
    ).toBe(true);
    expect(
      accepted({
        "base.json": '{ "compilerOptions": { "rewriteRelativeImportExtensions": true } }',
        "tsconfig.json": '{ "extends": "./base.json", "compilerOptions": { "rewriteRelativeImportExtensions": false } }',
      }),
    ).toBe(false);
    expect(
      accepted({
        "a.json": '{ "compilerOptions": { "rewriteRelativeImportExtensions": true } }',
        "b.json": '{ "compilerOptions": { "rewriteRelativeImportExtensions": false } }',
        "tsconfig.json": '{ "extends": ["./a.json", "./b.json"] }',
      }),
    ).toBe(false);
    expect(
      accepted({
        "a.json": '{ "compilerOptions": { "rewriteRelativeImportExtensions": false } }',
        "b.json": '{ "extends": "./c.json" }',
        "c.json": '{ "compilerOptions": { "rewriteRelativeImportExtensions": true } }',
        "tsconfig.json": '{ "extends": ["./a.json", "./b.json"] }',
      }),
    ).toBe(true);
  });

  it("counts a file it cannot read as not accepting, and ends an extends cycle", () => {
    expect(accepted({ "tsconfig.json": "{ not json" })).toBe(false);
    expect(accepted({ "tsconfig.json": '{ "extends": "./missing.json" }' })).toBe(false);
    expect(accepted({ "a.json": '{ "extends": "./tsconfig.json" }', "tsconfig.json": '{ "extends": "./a.json" }' })).toBe(false);
  });
});
