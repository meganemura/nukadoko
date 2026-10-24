import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/errors.js";
import { loadProgram } from "../src/config/load-program.js";
import { commandWords, layerProgram, programSchema, type ProgramEnvironment } from "../src/config/program-schema.js";
import { copyFixtureToTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: nukadoko.program.ts's shape (src/config/program-schema.ts)
// and its loading (src/config/load-program.ts): how a command splits, the
// defaults `serve` gets, what the schema refuses, and how an environment
// layers over the top level.

describe("commandWords", () => {
  it("gives back the words a command string was joined from, whatever whitespace joins them", () =>
    hegel.test((tc) => {
      const words = tc.draw(gs.arrays(gs.text({ minSize: 1, maxSize: 6, alphabet: "az09./-=\"'{}" }), { minSize: 1, maxSize: 5 }));
      const gaps = words.map(() => tc.draw(gs.sampledFrom([" ", "  ", "\t", " \n "])));
      const command = `${tc.draw(gs.sampledFrom(["", " ", "\t"]))}${words.map((word, index) => `${word}${gaps[index]}`).join("")}`;
      expect(commandWords(command)).toEqual(words);
    }));

  it("gives back an argv array as written, a word with spaces included", () =>
    hegel.test((tc) => {
      const argv = tc.draw(gs.arrays(gs.text({ maxSize: 8, alphabet: "a b\t{}\"'" }), { minSize: 1, maxSize: 5 }));
      const words = commandWords(argv);
      expect(words).toEqual(argv);
      expect(words).not.toBe(argv);
    }));
});

describe("programSchema", () => {
  it("fills serve's defaults: an automatic port, the root path, and 60 seconds", () => {
    expect(programSchema.parse({ serve: { command: "npm start" } }).serve).toEqual({
      command: "npm start",
      port: "auto",
      ready: "/",
      timeout_ms: 60_000,
    });
  });

  it("accepts every field, and an environment that overrides any of them", () => {
    const setup = () => undefined;
    const version = () => "1.0.0";
    const result = programSchema.safeParse({
      build: [["npm", "run", "build"]],
      prepare: ["bin/rails db:prepare"],
      serve: { command: ["bin/rails", "server", "-p", "{port}"], port: 3000, ready: "/up", timeout_ms: 5000 },
      env: { DATABASE_URL: "sqlite3:{dir}/db.sqlite3" },
      setup,
      environments: {
        staging: { url: "https://staging.example", policy: "read-only", envFiles: [".env.staging"], version },
        "pr-12": { url: ({ name }: { name: string }) => `https://${name}.example` },
      },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    [{ serve: { command: "x" }, url: "http://a.example" }, "serve and url are two ways to reach the program"],
    [{ environments: { staging: { serve: { command: "x" }, url: "http://a.example" } } }, "serve and url are two ways to reach the program"],
    [{ serve: { command: "" } }, "must name a program to run"],
    [{ serve: { command: [] } }, "must name a program to run"],
    [{ build: ["   "] }, "must name a program to run"],
    [{ serve: { command: "x", ready: "up" } }, "must be a path starting with"],
    [{ serve: { command: "x", port: 0 } }, "port"],
    [{ environments: { "Bad Name": {} } }, "environments"],
    [{ environments: { staging: { policy: "readonly" } } }, "policy"],
    [{ environments: { staging: { version: "1.0.0" } } }, "must be a function returning string | Promise<string>"],
    [{ setup: "seed" }, "must be a function"],
    [{ baseURL: "http://a.example" }, "baseURL"],
  ])("refuses %j", (input, needle) => {
    const result = programSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(needle);
  });
});

const optionalCommands = gs.oneOf(gs.just(undefined), gs.arrays(gs.sampledFrom(["make", "npm ci", "bin/setup"]), { maxSize: 2 }));
const optionalEnv = gs.oneOf(
  gs.just(undefined),
  gs.maps(gs.sampledFrom(["PORT", "DATABASE_URL", "TOKEN"]), gs.sampledFrom(["{port}", "a", "b"]), { maxSize: 3 }).map((entries) => Object.fromEntries(entries)),
);
const optionalReach = gs.sampledFrom([{}, { url: "http://top.example" }, { serve: { command: "serve" } }, { url: "http://env.example" }, { serve: { command: "serve-env" } }]);

describe("layerProgram", () => {
  it("takes each field from the environment when it writes one, merges env by key, and keeps serve and url one choice", () =>
    hegel.test((tc) => {
      const top = programSchema.parse({ build: tc.draw(optionalCommands), prepare: tc.draw(optionalCommands), env: tc.draw(optionalEnv), ...tc.draw(optionalReach) });
      const environment: ProgramEnvironment | undefined = tc.draw(gs.booleans())
        ? programSchema.parse({ environments: { e: { build: tc.draw(optionalCommands), prepare: tc.draw(optionalCommands), env: tc.draw(optionalEnv), ...tc.draw(optionalReach) } } })
            .environments!.e
        : undefined;
      const recipe = layerProgram(top, environment);

      expect(recipe.build).toEqual(environment?.build ?? top.build ?? []);
      expect(recipe.prepare).toEqual(environment?.prepare ?? top.prepare ?? []);
      for (const [key, value] of Object.entries(recipe.env)) {
        expect(value).toBe(environment?.env?.[key] ?? top.env?.[key]);
      }
      expect(Object.keys(recipe.env).sort()).toEqual([...new Set([...Object.keys(top.env ?? {}), ...Object.keys(environment?.env ?? {})])].sort());
      const own = environment?.serve !== undefined || environment?.url !== undefined ? environment : top;
      if (own?.serve !== undefined) expect(recipe.reach).toEqual({ kind: "serve", serve: own.serve });
      else if (own?.url !== undefined) expect(recipe.reach).toEqual({ kind: "url", url: own.url });
      else expect(recipe.reach).toEqual({ kind: "none" });
    }));
});

describe("loadProgram", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("is null for a tree with no program file", async () => {
    expect(await loadProgram(rootDir)).toBeNull();
  });

  it("reads the default export, defaults applied, and names the file it read", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), 'export default { serve: { command: "node app.js" } };\n');
    expect(await loadProgram(rootDir)).toEqual({
      program: { serve: { command: "node app.js", port: "auto", ready: "/", timeout_ms: 60_000 } },
      fileName: "nukadoko.program.ts",
    });
  });

  it("names a case-only typo's real key, nested in an environment", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), 'export default { environments: { staging: { URL: "http://a.example" } } };\n');
    const error = await loadProgram(rootDir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe(
      `Invalid program at ${path.join(rootDir, "nukadoko.program.ts")}: unknown key(s): URL (did you mean "url"?)`,
    );
  });

  it("refuses a file with no default export, and two program files at once", async () => {
    await writeFile(path.join(rootDir, "nukadoko.program.ts"), "export const program = {};\n");
    await expect(loadProgram(rootDir)).rejects.toThrow(
      `${path.join(rootDir, "nukadoko.program.ts")} has no default export. nukadoko reads the default export as the program.`,
    );
    await writeFile(path.join(rootDir, "nukadoko.program.mts"), "export default {};\n");
    await expect(loadProgram(rootDir)).rejects.toThrow("nukadoko cannot tell which one to read");
  });
});
