import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { type Attachment, isUneditedStub, stepTemplate } from "../src/cli/scaffold.js";
import { stripCaptureNames } from "../src/binding/pattern.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka scaffold <name> --replace`. It overwrites a step
// file only while the file is still, byte for byte, the stub `--feature`
// wrote, and the `already exists` refusal names the `--replace` command for
// exactly that file.

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
        `Refusing to scaffold: ${STUB} already exists, and it still holds the stub scaffold wrote\n` +
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
        `Refusing to scaffold: ${STUB} is not the stub scaffold wrote (it has been edited, or another option wrote it), so --replace leaves it\n` +
        `do: rm ${STUB} if it holds no step to keep (or choose another step name), then run ${rerun} --replace\n`,
    });
    expect(plain).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: `Refusing to scaffold: ${STUB} already exists\ndo: rm ${STUB} if it holds no step to keep (or choose another step name), then run ${rerun}\n`,
    });
    expect(await readFile(path.join(rootDir, STUB), "utf8")).toBe(edited);
  });

  it("refuses to replace a step another scaffold option wrote", async () => {
    await cli(rootDir, [...COMMAND, "--replace"]);
    const command = await readFile(path.join(rootDir, STUB), "utf8");

    const result = await cli(rootDir, [...COMMAND, "--replace"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("so --replace leaves it\n");
    expect(await readFile(path.join(rootDir, STUB), "utf8")).toBe(command);
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

/** The offsets of `file` that are not on its `pattern:` line: an edit to
 * the pattern alone makes the stub of another pattern. */
function offsetsOutsidePattern(file: string, inclusiveEnd: boolean): number[] {
  const patternLine = /^ {2}pattern: .*$/m.exec(file);
  const last = inclusiveEnd ? file.length : file.length - 1;
  const offsets: number[] = [];
  for (let at = 0; at <= last; at += 1) {
    if (patternLine === null || at < patternLine.index || at > patternLine.index + patternLine[0].length) offsets.push(at);
  }
  return offsets;
}

function draftStub(tc: hegel.TestCase): { file: string; name: string; relativeFilePath: string } {
  const pattern = draftPattern(tc);
  const name = tc.draw(gs.sampledFrom(["i-run-greet-with", "the-output-is", "step-2"]));
  const relativeFilePath = `features/steps/${name}${tc.draw(gs.sampledFrom([".ts", ".mts"]))}`;
  const file = stepTemplate({
    name,
    pattern,
    captures: pattern === null ? [] : stripCaptureNames(pattern).captures,
    chained: [],
    variant: tc.draw(gs.sampledFrom(["when", "then"] as const)),
    entryPoint: null,
    cwd: null,
    description: null,
    relativeFilePath,
    attachment: pattern === null ? null : tc.draw(gs.sampledFrom<Attachment | null>([null, "docstring", "table"])),
  });
  return { file, name, relativeFilePath };
}

describe("isUneditedStub", () => {
  it("holds for every stub --feature writes", () =>
    hegel.test((tc) => {
      const { file, name, relativeFilePath } = draftStub(tc);
      expect(isUneditedStub(file, name, relativeFilePath)).toBe(true);
    }));

  it("fails once any text is added outside the pattern line", () =>
    hegel.test((tc) => {
      const { file, name, relativeFilePath } = draftStub(tc);
      const at = tc.draw(gs.sampledFrom(offsetsOutsidePattern(file, true)));
      const added = tc.draw(gs.text({ minSize: 1, maxSize: 8 }));
      expect(isUneditedStub(`${file.slice(0, at)}${added}${file.slice(at)}`, name, relativeFilePath)).toBe(false);
    }));

  it("fails once a character outside the pattern line is removed", () =>
    hegel.test((tc) => {
      const { file, name, relativeFilePath } = draftStub(tc);
      const at = tc.draw(gs.sampledFrom(offsetsOutsidePattern(file, false)));
      expect(isUneditedStub(`${file.slice(0, at)}${file.slice(at + 1)}`, name, relativeFilePath)).toBe(false);
    }));

  it("fails for a stub written under another name or path", () =>
    hegel.test((tc) => {
      const { file, name, relativeFilePath } = draftStub(tc);
      expect(isUneditedStub(file, `${name}-x`, relativeFilePath.replace(name, `${name}-x`))).toBe(false);
    }));
});
