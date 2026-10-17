import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { describeImportFailure, headLocation, STRIP_ONLY_SENTENCE } from "../src/config/import-failure.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

describe("headLocation", () => {
  it("reads back the file and line Node writes at the head of a syntax error", () =>
    hegel.test((tc) => {
      const segments = tc.draw(gs.arrays(gs.fromRegex("[a-z0-9_-]{1,8}"), { minSize: 1, maxSize: 4 }));
      const file = `/${segments.join("/")}.ts`;
      const line = tc.draw(gs.integers({ minValue: 1, maxValue: 100_000 }));
      const asUrl = tc.draw(gs.booleans());
      const namespaced = tc.draw(gs.booleans());
      const head = `${asUrl ? pathToFileURL(file).href : file}${namespaced ? "?nukadoko-namespace=0f-1" : ""}:${line}`;
      expect(headLocation(`${head}\nconst x = 1;\n      ^\n\nSyntaxError: boom`)).toEqual({ path: file, line });
    }));

  it("finds nothing in a stack that starts with the error's name", () => {
    expect(headLocation("Error: boom\n    at file:///a/b.ts:2:7")).toBeUndefined();
  });
});

describe("describeImportFailure", () => {
  const rootDir = "/project";
  const stepFile = "/project/features/steps/paint.ts";
  const located = (code: string | undefined, message: string, file: string, line: number) =>
    Object.assign(new SyntaxError(message), {
      code,
      stack: `${pathToFileURL(file).href}?nukadoko-namespace=ab:${line}\nexport enum Color { Red }\n\nSyntaxError: ${message}`,
    });
  const nowhere = () => undefined;

  it("names the strip-only cause and the line of the step file itself", () => {
    const error = located("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", "TypeScript enum is not supported in strip-only mode", stepFile, 3);
    expect(describeImportFailure(error, stepFile, rootDir, nowhere)).toEqual({
      message: `TypeScript enum is not supported in strip-only mode (features/steps/paint.ts:3)${STRIP_ONLY_SENTENCE}`,
      line: 3,
    });
  });

  it("names another file's location in the text and leaves line unset", () => {
    const error = located("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", "TypeScript enum is not supported in strip-only mode", "/project/lib/colors.ts", 1);
    expect(describeImportFailure(error, stepFile, rootDir, nowhere)).toEqual({
      message: `TypeScript enum is not supported in strip-only mode (lib/colors.ts:1)${STRIP_ONLY_SENTENCE}`,
    });
  });

  it("keeps the message line of Node 23's framed report and claims no location", () => {
    const error = Object.assign(
      new SyntaxError("  x TypeScript enum is not supported in strip-only mode\n   ,-[3:1]\n 3 | export enum Color { Red }\n   `----\n"),
      { code: "ERR_INVALID_TYPESCRIPT_SYNTAX", stack: "SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]:   x TypeScript enum" },
    );
    expect(describeImportFailure(error, stepFile, rootDir, nowhere)).toEqual({
      message: `TypeScript enum is not supported in strip-only mode${STRIP_ONLY_SENTENCE}`,
    });
  });

  it("asks the child probe only for a syntax error with no code and no location", () => {
    const asked: string[] = [];
    const locate = (file: string) => {
      asked.push(file);
      return { path: file, line: 9 };
    };
    const compileError = Object.assign(new SyntaxError("Identifier 'page' has already been declared"), {
      stack: "SyntaxError: Identifier 'page' has already been declared\n    at compileSourceTextModule",
    });
    expect(describeImportFailure(compileError, stepFile, rootDir, locate)).toEqual({
      message: "Identifier 'page' has already been declared (features/steps/paint.ts:9)",
      line: 9,
    });
    expect(describeImportFailure(new Error("boom"), stepFile, rootDir, locate)).toEqual({ message: "boom" });
    expect(asked).toEqual([stepFile]);
  });
});

describe("nuka check: a step file with an enum", () => {
  it("reports step-file-import-failed at the enum's line, with the strip-only sentence", async () => {
    await ensureNukadokoShim();
    const dir = await createEmptyTempDir();
    try {
      await mkdir(path.join(dir, "features", "steps"), { recursive: true });
      await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
      await writeFile(
        path.join(dir, "features", "steps", "paint.ts"),
        [
          'import { z } from "zod";',
          'import { defineStep } from "nukadoko";',
          "export enum Color { Red, Blue }",
          "export default defineStep({",
          '  pattern: "I paint it",',
          '  description: "Paints",',
          "  args: z.object({}),",
          "  returns: z.object({ color: z.number() }),",
          "  async run() {",
          "    return { color: Color.Red };",
          "  },",
          "});",
          "",
        ].join("\n"),
      );
      const stdout = createCaptureSink();
      const exitCode = await runCli(["check", "--json"], { rootDir: dir, stdout, stderr: createCaptureSink() });
      const report = JSON.parse(stdout.text()) as { errors: Array<{ code: string; file?: string; line?: number; message: string }> };
      expect(report.errors.filter((issue) => issue.code === "step-file-import-failed")).toEqual([
        {
          code: "step-file-import-failed",
          file: "features/steps/paint.ts",
          line: 3,
          message: `TypeScript enum is not supported in strip-only mode (features/steps/paint.ts:3)${STRIP_ONLY_SENTENCE}`,
          do: "Correct the import or the error that the message names in the file, then run nuka check again.",
        },
      ]);
      expect(exitCode).toBe(1);
    } finally {
      await removeTempDir(dir);
    }
  });
});
