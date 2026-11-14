import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  // Mode 000 is a file that exists and still cannot be read (a CI mount
  // with the wrong permissions). That used to come back as an empty record,
  // the same answer as a path that is not on disk, so the first requireEnv
  // blamed the key.
  it("reports an unreadable env file, naming the path and EACCES", async () => {
    const relativePath = "locked.env";
    await writeFile(path.join(dir, relativePath), "SECRET=value\n");
    await chmod(path.join(dir, relativePath), 0o000);

    expect(() => loadEnvFiles(dir, ["does-not-exist.env", relativePath])).toThrow(
      'env file "locked.env" could not be read: EACCES',
    );
  });

  it("reports a directory named like an env file, naming the path and EISDIR", async () => {
    const relativePath = "dirasfile.env";
    await mkdir(path.join(dir, relativePath));

    expect(() => loadEnvFiles(dir, [relativePath])).toThrow(
      'env file "dirasfile.env" could not be read: EISDIR',
    );
  });

  it("returns an empty record with no envFiles", () => {
    expect(loadEnvFiles(dir, [])).toEqual({});
  });
});
