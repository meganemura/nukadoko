import path from "node:path";
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { z } from "zod";
import { defineStep } from "../src/index.js";
import type { Vocabulary, VocabularyEntry } from "../src/discover/discover-steps.js";
import { sinceStepFiles } from "../src/run/criteria-since.js";

// Responsibility: the files `nuka run --since` compares for a step name,
// taken from the vocabulary alone: the step's own file, its parts' files
// however deep, and the config file only for a fixture the config
// defines. tests/run-since.test.ts runs the same walk through the CLI.

const rootDir = path.resolve("/project");

const part = defineStep({ pattern: "a part", description: "A part", args: z.object({}), returns: z.object({}), mutates: false, async run() { return {}; } });
const outer = defineStep({
  pattern: "an outer step",
  description: "Calls a part and needs the tenant fixture",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  parts: [part],
  // The destructured name is what stepFixtureNames reads; the type is
  // loose because the fixture bag of a bare test project names no fixture.
  async run({ tenant }: any) {
    void tenant;
    return {};
  },
});

function typed(name: string, file: string, step: typeof part | typeof outer): VocabularyEntry {
  return { kind: "typed", name, filePath: path.join(rootDir, file), step };
}

const vocabulary: Vocabulary = new Map([
  ["a-part", typed("a-part", "features/steps/a-part.ts", part)],
  ["an-outer-step", typed("an-outer-step", "features/steps/an-outer-step.ts", outer)],
]);

describe("sinceStepFiles", () => {
  it("names a step's file, its parts' files, and the config file for a fixture the config defines", () => {
    const files = sinceStepFiles({ rootDir, vocabulary, configFile: "nukadoko.config.ts", definedFixtures: new Set(["tenant"]) });
    expect(files.ofEntry("an-outer-step")).toEqual(["features/steps/an-outer-step.ts", "features/steps/a-part.ts", "nukadoko.config.ts"]);
    expect(files.ofEntry("a-part")).toEqual(["features/steps/a-part.ts"]);
    expect(files.ofEntry("no-such-step")).toEqual([]);
    expect(files.all).toEqual(["features/steps/a-part.ts", "features/steps/an-outer-step.ts", "nukadoko.config.ts"]);
  });

  it("leaves the config file out for a fixture the config does not define", () => {
    const files = sinceStepFiles({ rootDir, vocabulary, configFile: "nukadoko.config.ts", definedFixtures: new Set() });
    expect(files.ofEntry("an-outer-step")).toEqual(["features/steps/an-outer-step.ts", "features/steps/a-part.ts"]);
  });

  it("lists in `all` exactly the sorted union of every entry's files", () =>
    hegel.test((tc) => {
      const defined = tc.draw(gs.booleans());
      const files = sinceStepFiles({ rootDir, vocabulary, configFile: "nukadoko.config.ts", definedFixtures: new Set(defined ? ["tenant"] : []) });
      const union = [...new Set([...vocabulary.keys()].flatMap((name) => files.ofEntry(name)))].sort((a, b) => a.localeCompare(b));
      expect(files.all).toEqual(union);
    }));

  it("walks the vocabulary only when all is first read", () => {
    let walks = 0;
    const counted: Vocabulary = Object.assign(new Map(vocabulary), {
      keys(this: Map<string, VocabularyEntry>) {
        walks += 1;
        return Map.prototype.keys.call(this);
      },
    });
    const files = sinceStepFiles({ rootDir, vocabulary: counted, configFile: "nukadoko.config.ts", definedFixtures: new Set() });
    expect(walks).toBe(0);
    expect(files.ofEntry("a-part")).toEqual(["features/steps/a-part.ts"]);
    expect(walks).toBe(0);
    expect(files.all).toEqual(["features/steps/a-part.ts", "features/steps/an-outer-step.ts"]);
    expect(files.all).toBe(files.all);
    expect(walks).toBe(1);
  });
});
