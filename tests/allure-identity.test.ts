import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFullName, resolveProjectName, toPosixPath } from "../src/report/allure/identity.js";

describe("resolveProjectName", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-identity-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns package.json's name when present", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "my-project" }));
    expect(resolveProjectName(dir)).toBe("my-project");
  });

  it("returns null when package.json doesn't exist", () => {
    expect(resolveProjectName(dir)).toBeNull();
  });

  it("returns null when package.json isn't valid JSON", async () => {
    await writeFile(path.join(dir, "package.json"), "not json{{{");
    expect(resolveProjectName(dir)).toBeNull();
  });

  it("returns null when package.json has no string name", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    expect(resolveProjectName(dir)).toBeNull();
  });
});

describe("toPosixPath", () => {
  it("leaves an already-posix path unchanged", () => {
    expect(toPosixPath("features/checkout.feature")).toBe("features/checkout.feature");
  });
});

describe("buildFullName", () => {
  it("includes the project name when present", () => {
    expect(buildFullName("nukadoko", "features/checkout.feature", "a customer checks out")).toBe(
      "nukadoko:features/checkout.feature#a customer checks out",
    );
  });

  it("omits the project name (and its leading colon) when null", () => {
    expect(buildFullName(null, "features/checkout.feature", "a customer checks out")).toBe(
      "features/checkout.feature#a customer checks out",
    );
  });
});
