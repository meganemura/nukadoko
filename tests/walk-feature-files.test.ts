import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkFeatureFiles } from "../src/feature/load-features.js";

// Responsibility: the directory walk `nuka check` and a directory
// `nuka run` share. A `featuresDir` of "." is a real
// configuration, and the same walk is what `nuka run .` uses. Dependencies
// and the state directory both contain `.feature` files that are not the
// project's scenarios. The walk has to leave those directories alone, and
// it has nothing to report about them: they were never part of the suite.

async function writeFeature(root: string, relativePath: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, "Feature: ignored\n");
}

describe("walkFeatureFiles", () => {
  let root: string;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips node_modules and dot-directories at every depth and returns only the features it walked", async () => {
    root = await mkdtemp(path.join(tmpdir(), "walk-features-"));
    const kept = [
      "keep.feature",
      path.join("nested", "also.feature"),
      path.join("node_modules_extra", "kept.feature"),
      ".dotted.feature",
    ];
    const skipped = [
      path.join("node_modules", "dep.feature"),
      path.join("node_modules", "dep", "dep.feature"),
      path.join("pkg", "node_modules", "inner", "inner.feature"),
      path.join(".nukadoko", "drafts", "d.feature"),
      path.join(".git", "hooks", "nope.feature"),
      path.join("pkg", ".hidden", "secret.feature"),
    ];
    for (const relativePath of [...kept, ...skipped]) {
      await writeFeature(root, relativePath);
    }

    // A file whose own name starts with "." is not a directory, so it stays.
    // Step discovery skips directories only, and this walk follows that rule.
    // The return value is the whole report: a skipped directory adds no path
    // and no other result.
    const found = walkFeatureFiles(root)
      .map((file) => path.relative(root, file))
      .sort();

    expect(found).toEqual([...kept].sort());
  });
});
