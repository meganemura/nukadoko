import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSecretSet } from "../src/secrets/build-secret-set.js";

describe("buildSecretSet", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-secret-set-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collects every key/value from the given secret-source files", async () => {
    await writeFile(path.join(dir, ".env.secret"), "API_TOKEN=sekrit-value\nOTHER=another-value");

    const secrets = buildSecretSet(dir, [".env.secret"], []);
    expect([...secrets].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "API_TOKEN", value: "sekrit-value" },
      { name: "OTHER", value: "another-value" },
    ]);
  });

  it("merges multiple secret-source files, later files winning", async () => {
    await writeFile(path.join(dir, "a.env"), "SHARED=from-a-file\nONLY_A=only-a-value");
    await writeFile(path.join(dir, "b.env"), "SHARED=from-b-file");

    const secrets = buildSecretSet(dir, ["a.env", "b.env"], []);
    const byName = Object.fromEntries(secrets.map((entry) => [entry.name, entry.value]));
    expect(byName).toEqual({ SHARED: "from-b-file", ONLY_A: "only-a-value" });
  });

  it("excludes keys named in secrets.public", async () => {
    await writeFile(
      path.join(dir, ".env.secret"),
      "API_TOKEN=sekrit-value\nPUBLIC_KEY=not-a-real-secret",
    );

    const secrets = buildSecretSet(dir, [".env.secret"], ["PUBLIC_KEY"]);
    expect(secrets.map((entry) => entry.name)).toEqual(["API_TOKEN"]);
  });

  it("excludes values shorter than 4 characters", async () => {
    await writeFile(path.join(dir, ".env.secret"), "SHORT=abc\nLONG=abcd-efgh");

    const secrets = buildSecretSet(dir, [".env.secret"], []);
    expect(secrets.map((entry) => entry.name)).toEqual(["LONG"]);
  });

  it("ignores a configured secret-source file that does not exist on disk", () => {
    expect(buildSecretSet(dir, ["does-not-exist.env"], [])).toEqual([]);
  });

  it("returns an empty SecretSet when there are no secret-source files", () => {
    expect(buildSecretSet(dir, [], [])).toEqual([]);
  });
});
