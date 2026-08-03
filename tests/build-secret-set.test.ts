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

    const secrets = buildSecretSet(dir, { secretSourceFiles: [".env.secret"], publicKeys: [] });
    expect([...secrets].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "API_TOKEN", value: "sekrit-value" },
      { name: "OTHER", value: "another-value" },
    ]);
  });

  it("merges multiple secret-source files, later files winning", async () => {
    await writeFile(path.join(dir, "a.env"), "SHARED=from-a-file\nONLY_A=only-a-value");
    await writeFile(path.join(dir, "b.env"), "SHARED=from-b-file");

    const secrets = buildSecretSet(dir, { secretSourceFiles: ["a.env", "b.env"], publicKeys: [] });
    const byName = Object.fromEntries(secrets.map((entry) => [entry.name, entry.value]));
    expect(byName).toEqual({ SHARED: "from-b-file", ONLY_A: "only-a-value" });
  });

  it("excludes keys named in secrets.public", async () => {
    await writeFile(
      path.join(dir, ".env.secret"),
      "API_TOKEN=sekrit-value\nPUBLIC_KEY=not-a-real-secret",
    );

    const secrets = buildSecretSet(dir, {
      secretSourceFiles: [".env.secret"],
      publicKeys: ["PUBLIC_KEY"],
    });
    expect(secrets.map((entry) => entry.name)).toEqual(["API_TOKEN"]);
  });

  it("excludes values shorter than 4 characters", async () => {
    await writeFile(path.join(dir, ".env.secret"), "SHORT=abc\nLONG=abcd-efgh");

    const secrets = buildSecretSet(dir, { secretSourceFiles: [".env.secret"], publicKeys: [] });
    expect(secrets.map((entry) => entry.name)).toEqual(["LONG"]);
  });

  it("ignores a configured secret-source file that does not exist on disk", () => {
    expect(
      buildSecretSet(dir, { secretSourceFiles: ["does-not-exist.env"], publicKeys: [] }),
    ).toEqual([]);
  });

  it("returns an empty SecretSet when there are no secret-source files", () => {
    expect(buildSecretSet(dir, { secretSourceFiles: [], publicKeys: [] })).toEqual([]);
  });

  it("pulls a tracked file's key into the SecretSet when secrets.redact names it", async () => {
    await writeFile(path.join(dir, ".env.tracked"), "API_SECRET_KEY=redact-me-please");

    const secrets = buildSecretSet(dir, {
      secretSourceFiles: [],
      trackedFiles: [".env.tracked"],
      publicKeys: [],
      redactKeys: ["API_SECRET_KEY"],
    });
    expect(secrets).toEqual([{ name: "API_SECRET_KEY", value: "redact-me-please" }]);
  });

  it("leaves a tracked file's key out of the SecretSet when secrets.redact does not name it, even if the name looks like a secret", async () => {
    await writeFile(path.join(dir, ".env.tracked"), "API_SECRET_KEY=plain-in-the-clear");

    const secrets = buildSecretSet(dir, {
      secretSourceFiles: [],
      trackedFiles: [".env.tracked"],
      publicKeys: [],
      redactKeys: [],
    });
    expect(secrets).toEqual([]);
  });

  it("still excludes a redact-promoted key shorter than 4 characters", async () => {
    await writeFile(path.join(dir, ".env.tracked"), "SHORT_KEY=abc");

    const secrets = buildSecretSet(dir, {
      secretSourceFiles: [],
      trackedFiles: [".env.tracked"],
      publicKeys: [],
      redactKeys: ["SHORT_KEY"],
    });
    expect(secrets).toEqual([]);
  });

  it("keeps redacting untracked secret-source keys unchanged when trackedFiles/redactKeys are also given", async () => {
    await writeFile(path.join(dir, ".env.secret"), "API_TOKEN=sekrit-value");
    await writeFile(path.join(dir, ".env.tracked"), "SIGNING_KEY=tracked-key-value");

    const secrets = buildSecretSet(dir, {
      secretSourceFiles: [".env.secret"],
      trackedFiles: [".env.tracked"],
      publicKeys: [],
      redactKeys: ["SIGNING_KEY"],
    });
    expect([...secrets].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "API_TOKEN", value: "sekrit-value" },
      { name: "SIGNING_KEY", value: "tracked-key-value" },
    ]);
  });
});
