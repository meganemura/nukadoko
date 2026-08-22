import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z as zodZ } from "zod";
import { z } from "../src/index.js";
import { repoRoot } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

describe("nukadoko re-exports zod's z", () => {
  it("is the exact zod export, not a separate copy", () => {
    // Same object, not merely a compatible one: `vocabulary.ts` calls
    // `z.toJSONSchema` and `strict-args.ts` reads a schema's own
    // `.type` property on whatever `z.object(...)` produced. A second
    // zod copy would parse a user's schema with a `z.object` the
    // introspection code never sees, so identity is what this test has
    // to check, not just having a `.object()` method.
    expect(z).toBe(zodZ);
  });
});

// Responsibility: proves `import { z } from "nukadoko"` resolves without
// relying on npm's hoisting a nested dependency to a project's own
// top-level node_modules -- the failure a package manager with a stricter,
// non-hoisting layout hits on the very first step file. `npm install
// --install-strategy=nested` reproduces that layout with npm itself: every
// installed package keeps its own dependencies nested under it instead of
// flattened to the project root, the same shape a non-hoisting installer
// produces. The project is built under the OS temp directory rather than
// inside this repository (mirroring scripts/pack-check.mjs), because a
// project nested inside this repository's own tree would resolve the bare
// specifier "nukadoko" through this package's own self-reference
// (package.json's own `name` and `exports`) before node_modules is even
// consulted, and would find this repository's own top-level `zod` on the
// way -- both would hide the exact absence this test exists to catch.
//
// This one packs and installs inside the default test suite, unlike
// scripts/pack-check.mjs, which answers a different question (did the
// tarball ship everything the CLI needs at runtime) and is run by hand.
// The layout failure this catches reaches a user on the first step file
// they write, and the install costs about four seconds against a warm npm
// cache, which `npm ci` leaves behind on the same dependency set.
describe("import { z } from \"nukadoko\": resolution without a hoisted zod", () => {
  let tmpDir: string;
  let projectDir: string;
  let nukaBin: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-zod-reexport-"));
    const { stdout: packOutput } = await execFileAsync(
      "npm",
      ["pack", "--json", "--pack-destination", tmpDir],
      { cwd: repoRoot },
    );
    const [{ filename }] = JSON.parse(packOutput) as [{ filename: string }];
    const tarballPath = path.join(tmpDir, filename);

    projectDir = path.join(tmpDir, "project");
    await mkdir(projectDir, { recursive: true });
    await execFileAsync("npm", ["init", "-y"], { cwd: projectDir });
    const projectPackageJsonPath = path.join(projectDir, "package.json");
    const projectPackageJson = JSON.parse(await readFile(projectPackageJsonPath, "utf8"));
    projectPackageJson.type = "module";
    await writeFile(projectPackageJsonPath, `${JSON.stringify(projectPackageJson, null, 2)}\n`);

    await execFileAsync(
      "npm",
      ["install", tarballPath, "--install-strategy=nested", "--prefer-offline", "--no-audit", "--no-fund"],
      { cwd: projectDir },
    );

    nukaBin = path.join(projectDir, "node_modules", ".bin", "nuka");
  }, 60_000);

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("installs zod nested under nukadoko, not hoisted to the project's own node_modules", async () => {
    await expect(access(path.join(projectDir, "node_modules", "zod"))).rejects.toThrow();
    await expect(
      access(path.join(projectDir, "node_modules", "nukadoko", "node_modules", "zod")),
    ).resolves.toBeUndefined();
  });

  it("discovers a step file that imports z from nukadoko, with no zod resolvable at the project root", async () => {
    await execFileAsync(nukaBin, ["init"], { cwd: projectDir });
    await mkdir(path.join(projectDir, "features", "steps"), { recursive: true });
    await writeFile(
      path.join(projectDir, "features", "steps", "probe.ts"),
      [
        'import { defineStep, z } from "nukadoko";',
        "",
        "export default defineStep({",
        '  description: "probe step",',
        "  args: z.object({}),",
        "  returns: z.object({}),",
        "  run() {",
        "    return {};",
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    const { stdout } = await execFileAsync(nukaBin, ["steps", "--json"], { cwd: projectDir });
    const { steps, import_failures: importFailures } = JSON.parse(stdout);

    expect(importFailures).toEqual([]);
    expect(steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "probe" })]),
    );
  });
});
