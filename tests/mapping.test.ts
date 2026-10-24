import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { NukadokoConfig } from "../src/config/schema.js";
import { compareMapping, configMappingText, programMappingOf, type MappingSnapshot } from "../src/run/mapping.js";

// Responsibility: whether the mapping changed since `nuka run --base`'s
// ref (src/run/mapping.ts): the files under the features directory other
// than `.feature` files, the config's mapping part, and the program file's
// conditions and default selection. A mapping compared with itself never
// changed; any one of those parts that differs is named.

type MappingPart = Pick<NukadokoConfig, "fixtures" | "parameterTypes" | "secrets" | "worldParameters">;
const configText = (part: Partial<MappingPart>): string =>
  configMappingText({ fixtures: {}, parameterTypes: [], secrets: { public: [], redact: [] }, worldParameters: {}, ...part });

const files = gs
  .arrays(gs.tuples(gs.sampledFrom(["steps/a.ts", "steps/b.ts", "support/world.ts", "data/users.json"]), gs.sampledFrom(["h1", "h2"])), { maxSize: 4 })
  .map((entries) => new Map(entries));
const program = gs
  .tuples(
    gs.arrays(gs.tuples(gs.sampledFrom(["flag-on", "flag-off", "default"]), gs.sampledFrom([undefined, { banner: true }, { banner: false }, { mode: "dark" }])), { maxSize: 3 }),
    gs.sampledFrom([undefined, ["flag-on"], ["flag-on", "flag-off"]]),
  )
  .map(([environments, defaultEnvironments]) =>
    programMappingOf({
      environments: Object.fromEntries(environments.map(([name, conditions]) => [name, conditions === undefined ? {} : { conditions }])),
      ...(defaultEnvironments === undefined ? {} : { defaultEnvironments }),
    }),
  );
const snapshot = gs
  .tuples(files, gs.sampledFrom([{ text: configText({ secrets: { public: ["TOKEN"], redact: [] } }) }, { text: configText({ worldParameters: { a: 1 } }) }]), program)
  .map(([fileMap, config, programMapping]): MappingSnapshot => ({ files: fileMap, config, program: programMapping }));

describe("compareMapping", () => {
  it("finds no change between a mapping and itself", () =>
    hegel.test((tc) => {
      const same = tc.draw(snapshot);
      expect(compareMapping(same, same)).toEqual({ changed: false, files: [], config: false, conditions: [], defaultEnvironments: false });
    }));

  it("is changed exactly when some part it names differs, whichever side is the base", () =>
    hegel.test((tc) => {
      const base = tc.draw(snapshot);
      const head = tc.draw(snapshot);
      const forward = compareMapping(base, head);
      const backward = compareMapping(head, base);
      expect(forward).toEqual(backward);
      expect(forward.changed).toBe(forward.files.length > 0 || forward.config || forward.conditions.length > 0 || forward.defaultEnvironments);
    }));

  const plain: MappingSnapshot = { files: new Map(), config: { text: "{}" }, program: programMappingOf(null) };

  it("names an environment whose conditions changed, and a new default selection", () => {
    const before = { ...plain, program: programMappingOf({ environments: { "flag-on": { conditions: { banner: true } }, "flag-off": { conditions: { banner: false } } } }) };
    const after = {
      ...plain,
      program: programMappingOf({ environments: { "flag-on": { conditions: { banner: true } }, "flag-off": { conditions: { banner: false, cache: true } } }, defaultEnvironments: ["flag-on"] } as never),
    };
    expect(compareMapping(before, after)).toEqual({ changed: true, files: [], config: false, conditions: ["flag-off"], defaultEnvironments: true });
  });

  it("reads conditions written in another key order as the same", () => {
    const before = { ...plain, program: programMappingOf({ environments: { on: { conditions: { banner: true, mode: "dark" } } } }) };
    const after = { ...plain, program: programMappingOf({ environments: { on: { conditions: { mode: "dark", banner: true } } } }) };
    expect(compareMapping(before, after).changed).toBe(false);
  });

  it("counts a program file or a config that did not load at the ref as changed", () => {
    const head = { ...plain, program: programMappingOf({ environments: { on: { conditions: { banner: true } } } }) };
    expect(compareMapping({ ...plain, program: { problem: "it threw" } }, head)).toEqual({ changed: true, files: [], config: false, conditions: ["on"], defaultEnvironments: true });
    expect(compareMapping({ ...plain, config: { problem: "it threw" } }, plain)).toEqual({ changed: true, files: [], config: true, conditions: [], defaultEnvironments: false });
  });

  it("compares a function in the config's mapping part by its source", () => {
    const one = configText({ parameterTypes: [{ name: "n", regexp: /\d+/, transformer: (value: string) => Number(value) }] });
    const two = configText({ parameterTypes: [{ name: "n", regexp: /\d+/, transformer: (value: string) => Number(value) + 1 }] });
    expect(compareMapping({ ...plain, config: { text: one } }, { ...plain, config: { text: two } }).config).toBe(true);
    expect(compareMapping({ ...plain, config: { text: one } }, { ...plain, config: { text: one } }).config).toBe(false);
  });
});
