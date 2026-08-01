import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvFiles } from "../src/context/env.js";

describe("loadEnvFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-env-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses KEY=VALUE, an export prefix, quotes, comments, and blank lines", async () => {
    await writeFile(
      path.join(dir, ".env"),
      [
        "# a comment",
        "",
        "export FOO=bar",
        'BAZ="quoted value"',
        "QUX='single quoted'",
        "PLAIN=plain",
      ].join("\n"),
    );

    const env = loadEnvFiles(dir, [".env"]);
    expect(env).toEqual({
      FOO: "bar",
      BAZ: "quoted value",
      QUX: "single quoted",
      PLAIN: "plain",
    });
  });

  it("merges multiple files in order, later files winning", async () => {
    await writeFile(path.join(dir, "a.env"), "SHARED=a\nONLY_A=1");
    await writeFile(path.join(dir, "b.env"), "SHARED=b\nONLY_B=2");

    const env = loadEnvFiles(dir, ["a.env", "b.env"]);
    expect(env).toEqual({ SHARED: "b", ONLY_A: "1", ONLY_B: "2" });
  });

  it("ignores a configured file that does not exist", () => {
    expect(loadEnvFiles(dir, ["does-not-exist.env"])).toEqual({});
  });

  it("returns an empty record with no envFiles", () => {
    expect(loadEnvFiles(dir, [])).toEqual({});
  });
});
