import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { includeMayCover, missingIncludeEntries, parseJsonc } from "../src/cli/tsconfig-include.js";

// Responsibility: the pure half of `nuka init`'s tsconfig hint. The JSONC
// reader must give back what JSON.parse gives for the same value with
// comments and trailing commas around it, and the coverage rule must never
// claim a path is left out when an entry could reach it.

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
