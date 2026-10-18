import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  type PathSegment,
  parseRequestFlag,
  readRequestPath,
  requestFlagText,
  requestPathExpression,
} from "../src/cli/scaffold.js";
import { createCaptureSink, createEmptyTempDir, ensureNukadokoShim, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka scaffold <name> --request "<METHOD> <path>"`, the
// When step that sends one request through Playwright's `request` and
// returns its status and body, and the path expression it writes.

async function cli(rootDir: string, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

describe("nuka scaffold --request", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createEmptyTempDir();
    await ensureNukadokoShim();
    if ((await cli(rootDir, ["init"])).exitCode !== 0) throw new Error("test setup: `nuka init` failed");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes a When step that sends the request and returns its status and body", async () => {
    const result = await cli(rootDir, ["scaffold", "get-item", "--pattern", "I request item {id:int}", "--request", "GET /items/{id}"]);

    expect(result).toEqual({ exitCode: 0, stdout: "features/steps/get-item.ts\n", stderr: "" });
    expect(await readFile(path.join(rootDir, "features", "steps", "get-item.ts"), "utf8")).toBe(
      [
        'import { defineStep, z } from "nukadoko";',
        "",
        "export default defineStep({",
        '  description: "Send GET /items/{id} and return the response\'s status and body",',
        '  pattern: "I request item {id:int}",',
        "  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.",
        "  args: z.object({",
        "    id: z.number(),",
        "  }),",
        "  returns: z.object({",
        "    status: z.number(),",
        "    body: z.string(),",
        "  }),",
        "  // The method is no proof either way: set this to false when the request changes nothing on the server.",
        "  mutates: true,",
        "  async run({ request }, { id }) {",
        '    const response = await request.fetch(`/items/${id}`, { method: "GET" });',
        "    return { status: response.status(), body: await response.text() };",
        "  },",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("sends the docstring with --body, and throws by name for a value the request does not read", async () => {
    await writeFile(
      path.join(rootDir, "features", "items.feature"),
      'Feature: items\n  Scenario: one\n    When "lamp" is posted to /items\n      """\n      {"name":"lamp"}\n      """\n',
    );

    const result = await cli(rootDir, [
      "scaffold",
      "post-item",
      "--pattern",
      "{name:string} is posted to \\/items",
      "--request",
      "POST /items",
      "--body",
      "docstring",
    ]);

    expect(result.exitCode).toBe(0);
    const written = await readFile(path.join(rootDir, "features", "steps", "post-item.ts"), "utf8");
    expect(written).toContain(
      "    // TODO: pass each value where the request reads it: the path, or fetch's\n" +
        "    // data, headers, or params option. Then delete the throw.\n" +
        "    throw new Error(`pass name where the request reads them: features/steps/post-item.ts:20; args ${JSON.stringify({ name })}`);\n" +
        '    const response = await request.fetch("/items", { method: "POST", data: docstring });\n',
    );
    expect(written.split("\n")[19]).toBe("    throw new Error(`pass name where the request reads them: features/steps/post-item.ts:20; args ${JSON.stringify({ name })}`);");
    expect(await cli(rootDir, ["check"])).toEqual({
      exitCode: 0,
      stdout:
        'warning\tscenario-without-then\tfeatures/items.feature:2\tScenario "one" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.\n' +
        "  do: Add a Then line that checks the outcome the scenario is for.\n",
      stderr: "",
    });
  });

  it("refuses a path key no capture fills, a malformed flag, --body alone, and --request beside --then or --command", async () => {
    const pattern = ["--pattern", "I request item {id:int}"];

    expect(await cli(rootDir, ["scaffold", "get-item", ...pattern, "--request", "GET /items/{key}"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        "Refusing to scaffold: --request's path names {key}, which no capture or --from fills (its keys are id); a {key} in the path is put in by that args key's value\ndo: nuka scaffold --help\n",
    });
    expect((await cli(rootDir, ["scaffold", "get-item", ...pattern, "--request", "/items/{id}"])).stderr).toBe(
      'Refusing to scaffold: --request takes "<METHOD> <path>", an upper-case method and a path with no space, each {key} in it an args key, such as "GET /items/{id}", and got "/items/{id}"\ndo: nuka scaffold --help\n',
    );
    expect((await cli(rootDir, ["scaffold", "get-item", ...pattern, "--body", "id"])).stderr).toBe(
      "Refusing to scaffold: --body names the args key a --request step sends, and only a --request step sends one\ndo: nuka scaffold --help\n",
    );
    expect((await cli(rootDir, ["scaffold", "get-item", ...pattern, "--request", "GET /x", "--then"])).stderr).toContain(
      "--request and --then together",
    );
    expect((await cli(rootDir, ["scaffold", "get-item", ...pattern, "--request", "GET /x", "--command"])).stderr).toContain(
      "--request and --command together",
    );
    expect((await cli(rootDir, ["scaffold", "get-item", ...pattern, "--request", "GET /x", "--body", "docstring"])).stderr).toBe(
      "Refusing to scaffold: --body docstring names no args key of this step (its keys are id); no feature line this pattern matches carries a docstring (write the line first)\ndo: nuka scaffold --help\n",
    );
  });
});

const KEYS = ["id", "name", "path", "$x", "_y"] as const;
const text = gs.text({ minSize: 1, maxSize: 6, alphabet: "ab/?=&.-_~%\\`$" });

function draftPath(tc: hegel.TestCase): PathSegment[] {
  const pieces = tc.draw(gs.arrays(gs.oneOf(text.map((value): PathSegment => ({ text: value })), gs.sampledFrom(KEYS).map((key): PathSegment => ({ key }))), { minSize: 1, maxSize: 6 }));
  // Adjacent text pieces read back as one.
  const merged: PathSegment[] = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    if ("text" in piece && last !== undefined && "text" in last) merged[merged.length - 1] = { text: last.text + piece.text };
    else merged.push(piece);
  }
  return merged;
}

describe("requestPathExpression", () => {
  it("evaluates to the text with each key's value in its place", () =>
    hegel.test((tc) => {
      const segments = draftPath(tc);
      const values = Object.fromEntries(KEYS.map((key) => [key, tc.draw(gs.text({ maxSize: 4 }))]));
      const evaluate = new Function(...KEYS, `return ${requestPathExpression(segments)};`) as (...args: string[]) => string;
      expect(evaluate(...KEYS.map((key) => values[key]!))).toBe(
        segments.map((segment) => ("key" in segment ? values[segment.key] : segment.text)).join(""),
      );
    }));

  it("reads back as the segments it was written from", () =>
    hegel.test((tc) => {
      const segments = draftPath(tc);
      const expected = segments.every((segment) => "text" in segment)
        ? [{ text: segments.map((segment) => ("text" in segment ? segment.text : "")).join("") }]
        : segments;
      expect(readRequestPath(requestPathExpression(segments))).toEqual(expected);
    }));
});

describe("parseRequestFlag", () => {
  it("reads back the text a shape is written as, for a path with no brace or space", () =>
    hegel.test((tc) => {
      const segments = draftPath(tc).filter((segment) => !("text" in segment) || !/[{}\s]/.test(segment.text));
      if (segments.length === 0) return;
      const shape = { method: tc.draw(gs.sampledFrom(["GET", "POST", "DELETE", "PATCH"])), path: segments };
      expect(parseRequestFlag(requestFlagText(shape))).toEqual(shape);
    }));
});
