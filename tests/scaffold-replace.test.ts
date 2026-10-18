import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { type Attachment, type ChainedField, isUneditedStub, type Producer, stepTemplate } from "../src/cli/scaffold.js";
import type { PrimitiveClass } from "../src/binding/schema-shape.js";
import { stripCaptureNames } from "../src/binding/pattern.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka scaffold <name> --replace`. It overwrites a step
// file only while the file is still, byte for byte, what scaffold writes
// under some set of options, and the `already exists` refusal names the
// `--replace` command for exactly that file.

async function cli(rootDir: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

const STUB = "features/steps/i-run-greet-with.ts";
const COMMAND = ["scaffold", "i-run-greet-with", "--pattern", "I run greet with {name:string}", "--command", "src/cli.ts"];

describe("nuka scaffold --replace", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    const init = await cli(rootDir, ["init"]);
    if (init.exitCode !== 0) throw new Error("test setup: `nuka init` failed");
    await writeFile(path.join(rootDir, "features", "greet.feature"), 'Feature: greet\n  Scenario: Ada\n    When I run greet with "Ada"\n');
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src", "cli.ts"), 'console.log("hi");\n');
    const feature = await cli(rootDir, ["scaffold", "--feature", "features/greet.feature"]);
    if (feature.stdout !== `${STUB}\n`) throw new Error(`test setup: --feature wrote ${feature.stdout}`);
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("names the --replace command when the file is still the stub --feature wrote", async () => {
    const stub = await readFile(path.join(rootDir, STUB), "utf8");

    const result = await cli(rootDir, COMMAND);

    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        `Refusing to scaffold: ${STUB} already exists, and it still holds what scaffold wrote\n` +
        "do: nuka scaffold i-run-greet-with --pattern 'I run greet with {name:string}' --command src/cli.ts --replace\n",
    });
    expect(await readFile(path.join(rootDir, STUB), "utf8")).toBe(stub);
  });

  it("overwrites the unedited stub with the step the command describes", async () => {
    const result = await cli(rootDir, [...COMMAND, "--replace"]);

    expect(result).toEqual({ exitCode: 0, stdout: `${STUB}\n`, stderr: "" });
    const written = await readFile(path.join(rootDir, STUB), "utf8");
    expect(written).toContain('const cli = resolve("src/cli.ts");\n');
    expect(written).toContain("return await runCommand(process.execPath, [cli, name], { cwd: scratch.dir() });\n");
  });

  it("refuses to replace a stub someone edited, and leaves it as it is", async () => {
    const edited = (await readFile(path.join(rootDir, STUB), "utf8")).replace(
      "    throw new Error(",
      "    // started on this\n    throw new Error(",
    );
    await writeFile(path.join(rootDir, STUB), edited);

    const replaced = await cli(rootDir, [...COMMAND, "--replace"]);
    const plain = await cli(rootDir, COMMAND);

    const rerun = "nuka scaffold i-run-greet-with --pattern 'I run greet with {name:string}' --command src/cli.ts";
    expect(replaced).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        `Refusing to scaffold: ${STUB} is not what scaffold writes (someone edited it, or scaffold did not write it), so --replace leaves it\n` +
        `do: rm ${STUB} if it holds no step to keep (or choose another step name), then run ${rerun} --replace\n`,
    });
    expect(plain).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: `Refusing to scaffold: ${STUB} already exists\ndo: rm ${STUB} if it holds no step to keep (or choose another step name), then run ${rerun}\n`,
    });
    expect(await readFile(path.join(rootDir, STUB), "utf8")).toBe(edited);
  });

  it("redoes an unedited --command step with an option it lacked", async () => {
    await cli(rootDir, [...COMMAND, "--replace"]);

    const result = await cli(rootDir, [...COMMAND, "--argv", "name", "--replace"]);

    expect(result).toEqual({ exitCode: 0, stdout: `${STUB}\n`, stderr: "" });
    expect(await readFile(path.join(rootDir, STUB), "utf8")).toContain(
      '    return await runCommand(process.execPath, [cli, ...name.split(/\\s+/).filter((part) => part !== "")], { cwd: scratch.dir() });\n',
    );
  });

  it("offers --replace for an unedited --command step, and refuses it once the step is edited", async () => {
    await cli(rootDir, [...COMMAND, "--replace"]);
    const offered = await cli(rootDir, COMMAND);
    const edited = (await readFile(path.join(rootDir, STUB), "utf8")).replace("mutates: true", "mutates: false");
    await writeFile(path.join(rootDir, STUB), edited);

    const refused = await cli(rootDir, [...COMMAND, "--replace"]);

    expect(offered.stderr).toBe(
      `Refusing to scaffold: ${STUB} already exists, and it still holds what scaffold wrote\n` +
        "do: nuka scaffold i-run-greet-with --pattern 'I run greet with {name:string}' --command src/cli.ts --replace\n",
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("so --replace leaves it\n");
    expect(await readFile(path.join(rootDir, STUB), "utf8")).toBe(edited);
  });

  it("is refused beside --feature, which never overwrites", async () => {
    const result = await cli(rootDir, ["scaffold", "--feature", "features/greet.feature", "--replace"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("leave out --replace");
  });
});

const word = gs.sampledFrom(["I", "run", "greet", "with", "the", "output", "is", "it's", "a/b", "(x)", "\\{"]);
const capture = gs.sampledFrom(["string", "int", "float", "word", "custom"]);

function draftPattern(tc: hegel.TestCase): string | null {
  if (tc.draw(gs.booleans())) return null;
  const pieces = tc.draw(gs.arrays(gs.oneOf(word, capture.map((type) => `\u0001${type}`)), { minSize: 1, maxSize: 6 }));
  let index = 0;
  return pieces.map((piece) => (piece.startsWith("\u0001") ? `{key${(index += 1)}:${piece.slice(1)}}` : piece)).join(" ");
}

/** The lines `isUneditedStub` reads an option back from. An edit there
 * may make the file another option's template, so the edit properties
 * leave them alone. */
const READ_LINES = /^(?: {2}pattern: | {2}description: |const cli = |import | {4}[A-Za-z_$][A-Za-z0-9_$]*: \[| {4}return await runCommand\().*$/gm;

/** The offsets of `file` outside every line an option is read from. */
function offsetsOutsideReadLines(file: string, inclusiveEnd: boolean): number[] {
  const read = [...file.matchAll(READ_LINES)].map((match) => [match.index, match.index + match[0].length] as const);
  const last = inclusiveEnd ? file.length : file.length - 1;
  const offsets: number[] = [];
  for (let at = 0; at <= last; at += 1) {
    if (!read.some(([from, to]) => at >= from && at <= to)) offsets.push(at);
  }
  return offsets;
}

const KEYS = ["dir", "out", "status", "body"] as const;

function draftChained(tc: hegel.TestCase, captureKeys: readonly string[]): ChainedField[] {
  const keys = tc.draw(gs.arrays(gs.sampledFrom(KEYS), { maxSize: 3, unique: true })).filter((key) => !captureKeys.includes(key));
  return keys.map((key) => {
    const steps = tc.draw(gs.arrays(gs.sampledFrom(["make-dir", "run-it", "send"]), { minSize: 1, maxSize: 2, unique: true }));
    const producers = steps.map((step) => ({
      step,
      identifier: step.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
      specifier: `./${step}.ts`,
    }));
    return {
      key,
      producers: producers as [Producer, ...Producer[]],
      valueClass: tc.draw(gs.sampledFrom<PrimitiveClass>(["string", "number", "other"])),
    };
  });
}

function draftStub(tc: hegel.TestCase): { file: string; name: string; relativeFilePath: string } {
  const pattern = draftPattern(tc);
  const name = tc.draw(gs.sampledFrom(["i-run-greet-with", "the-output-is", "step-2"]));
  const relativeFilePath = `features/steps/${name}${tc.draw(gs.sampledFrom([".ts", ".mts"]))}`;
  const captures = pattern === null ? [] : stripCaptureNames(pattern).captures;
  const variant = tc.draw(gs.sampledFrom(["when", "then", "command"] as const));
  const chained = draftChained(tc, captures.map((capture) => capture.key));
  const stringKeys = [...captures.filter((capture) => capture.type === "string").map((capture) => capture.key)];
  const command = variant === "command";
  const file = stepTemplate({
    name,
    pattern,
    captures,
    chained,
    variant,
    entryPoint: command ? tc.draw(gs.sampledFrom([null, "src/cli.ts", 'bin/"odd" path.mjs'])) : null,
    cwd: command && chained.length > 0 ? tc.draw(gs.sampledFrom([null, chained[0]!.key])) : null,
    argvKey: command && stringKeys.length > 0 ? tc.draw(gs.sampledFrom([null, stringKeys[0]!])) : null,
    description: tc.draw(gs.sampledFrom([null, "Run the program", 'Say "hi" \\ twice'])),
    relativeFilePath,
    attachment: pattern === null || command ? null : tc.draw(gs.sampledFrom<Attachment | null>([null, "docstring", "table"])),
  });
  return { file, name, relativeFilePath };
}

describe("isUneditedStub", () => {
  it("holds for every file scaffold writes, under any options", () =>
    hegel.test((tc) => {
      const { file, name, relativeFilePath } = draftStub(tc);
      expect(isUneditedStub(file, name, relativeFilePath)).toBe(true);
    }));

  it("fails once any text is added outside the lines an option is read from", () =>
    hegel.test((tc) => {
      const { file, name, relativeFilePath } = draftStub(tc);
      const at = tc.draw(gs.sampledFrom(offsetsOutsideReadLines(file, true)));
      const added = tc.draw(gs.text({ minSize: 1, maxSize: 8 }));
      expect(isUneditedStub(`${file.slice(0, at)}${added}${file.slice(at)}`, name, relativeFilePath)).toBe(false);
    }));

  it("fails once a character outside the lines an option is read from is removed", () =>
    hegel.test((tc) => {
      const { file, name, relativeFilePath } = draftStub(tc);
      const at = tc.draw(gs.sampledFrom(offsetsOutsideReadLines(file, false)));
      expect(isUneditedStub(`${file.slice(0, at)}${file.slice(at + 1)}`, name, relativeFilePath)).toBe(false);
    }));

  it("fails under another name or path for a file that names its own", () =>
    hegel.test((tc) => {
      const { file, name, relativeFilePath } = draftStub(tc);
      // The description is read back as an option, so only a name elsewhere
      // (a stub's message, a guard's path) ties the file to its own.
      if (!file.replace(/^ {2}description: .*$/m, "").includes(name)) return;
      expect(isUneditedStub(file, `${name}-x`, relativeFilePath.replace(name, `${name}-x`))).toBe(false);
    }));
});
