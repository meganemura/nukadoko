import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { NukadokoConfig } from "../src/config/schema.js";
import { configSchema } from "../src/config/schema.js";
import { compareMapping, configFileMappingText, configMappingText, programMappingOf, RUN_SETTINGS, type MappingSnapshot } from "../src/run/mapping.js";

// Responsibility: whether the mapping changed since `nuka run --base`'s
// ref (src/run/mapping.ts): the files under the features directory other
// than `.feature` files, the config's mapping part, and the program's
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
const config = gs
  .tuples(gs.sampledFrom([configText({ secrets: { public: ["TOKEN"], redact: [] } }), configText({ worldParameters: { a: 1 } })]), gs.sampledFrom([null, "h1", "h2"]))
  .map(([text, file]) => ({ text, file }));
const snapshot = gs.tuples(files, config, program).map(([fileMap, configPart, programMapping]): MappingSnapshot => ({ files: fileMap, config: configPart, program: programMapping }));

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

  const plain: MappingSnapshot = { files: new Map(), config: { text: "{}", file: "h1" }, program: programMappingOf(null) };

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

  it("counts a program or a config that did not load at the ref as changed", () => {
    const head = { ...plain, program: programMappingOf({ environments: { on: { conditions: { banner: true } } } }) };
    expect(compareMapping({ ...plain, program: { problem: "it threw" } }, head)).toEqual({ changed: true, files: [], config: false, conditions: ["on"], defaultEnvironments: true });
    expect(compareMapping({ ...plain, config: { problem: "it threw" } }, plain)).toEqual({ changed: true, files: [], config: true, conditions: [], defaultEnvironments: false });
  });

  it("compares a function in the config's mapping part by its source", () => {
    const one = configText({ parameterTypes: [{ name: "n", regexp: /\d+/, transformer: (value: string) => Number(value) }] });
    const two = configText({ parameterTypes: [{ name: "n", regexp: /\d+/, transformer: (value: string) => Number(value) + 1 }] });
    expect(compareMapping({ ...plain, config: { text: one, file: "h1" } }, { ...plain, config: { text: two, file: "h1" } }).config).toBe(true);
    expect(compareMapping({ ...plain, config: { text: one, file: "h1" } }, { ...plain, config: { text: one, file: "h1" } }).config).toBe(false);
  });

  it("counts the config as changed exactly when its mapping part or its file's bytes differ", () =>
    hegel.test((tc) => {
      const before = tc.draw(config);
      const after = tc.draw(config);
      const changed = compareMapping({ ...plain, config: before }, { ...plain, config: after });
      expect(changed.config).toBe(before.text !== after.text || before.file !== after.file);
      expect(changed.changed).toBe(changed.config);
    }));
});

describe("configMappingText", () => {
  it("counts every config field as mapping but where records are written, how many are kept, and the program", () =>
    hegel.test((tc) => {
      const base = configSchema.parse({}) as Record<string, unknown>;
      const key = tc.draw(gs.sampledFrom(Object.keys(configSchema.shape)));
      const changed = { ...base, [key]: { a: tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) } };
      expect(configMappingText(changed) !== configMappingText(base)).toBe(![...RUN_SETTINGS, "program"].includes(key));
    }));

  it("names the fields left out of the mapping", () => {
    expect(RUN_SETTINGS).toEqual(["stateDir", "retention"]);
  });
});

describe("configFileMappingText", () => {
  // The program goes with the code: a config whose program alone changed
  // reads as the same mapping, and one changed beside it does not.
  const file = (program: string, rest = "headless: true"): string =>
    `import { defineConfig } from "nukadoko";\n\nexport default defineConfig({\n  browser: { ${rest} },\n  program: ${program},\n});\n`;
  const programs = gs.sampledFrom([
    "() => ({ url: \"http://a.example\" })",
    "() => ({ serve: { command: \"node app.mjs\", ready: \"/up\" }, env: { PORT: \"{port}\" } })",
    "() => ({})",
  ]);

  it("is the same text for two configs that differ only in their program", () =>
    hegel.test((tc) => {
      const one = tc.draw(programs);
      const two = tc.draw(programs);
      expect(configFileMappingText(file(one), (0, eval)(one))).toBe(configFileMappingText(file(two), (0, eval)(two)));
    }));

  it("keeps what lies beside the program", () =>
    hegel.test((tc) => {
      const program = tc.draw(programs);
      expect(configFileMappingText(file(program), (0, eval)(program))).not.toBe(configFileMappingText(file(program, "headless: false"), (0, eval)(program)));
    }));

  it("reads the whole file when the program's source is not in it exactly once", () => {
    const program = () => ({});
    const text = `${program.toString()} ${program.toString()}`;
    expect(configFileMappingText(text, program)).toBe(text);
    expect(configFileMappingText("export default {};", program)).toBe("export default {};");
    expect(configFileMappingText("export default {};", undefined)).toBe("export default {};");
  });
});
