import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { discoverSteps } from "../src/discover/discover-steps.js";
import { DuplicateCompatStepError } from "../src/discover/errors.js";
import { createEmptyTempDir, fixture, removeTempDir, repoRoot } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: discovery/registration
// tests — compat steps (Given/When/Then, string and RegExp patterns) land
// in the vocabulary with `kind: "compat"`, attributed to the file that
// registered them; two registrations sharing a pattern source collide
// (DuplicateCompatStepError); and two concurrent discovery runs never
// cross-contaminate each other's compat buffers (tsx namespace isolation,
// src/compat/registry.ts's own header comment).

describe("discoverSteps: compat registration", () => {
  it("finds compat steps registered via Given/When/Then, string and RegExp patterns alike", async () => {
    const { vocabulary } = await discoverSteps(fixture("compat-project"), "features");

    const given = vocabulary.get("compat: a legacy project {string} exists");
    expect(given?.kind).toBe("compat");
    if (given?.kind !== "compat") return;
    expect(given.compat.keyword).toBe("Given");
    expect(given.compat.pattern).toBe("a legacy project {string} exists");
    expect(given.filePath).toContain(path.join("features", "steps", "legacy-glue.ts"));

    const when = vocabulary.get("compat: /^a legacy request is made$/");
    expect(when?.kind).toBe("compat");
    if (when?.kind !== "compat") return;
    expect(when.compat.keyword).toBe("When");
    expect(when.compat.pattern).toBeInstanceOf(RegExp);

    const then = vocabulary.get("compat: the legacy result is {string}");
    expect(then?.kind).toBe("compat");
    if (then?.kind !== "compat") return;
    expect(then.compat.keyword).toBe("Then");
  });

  it("does not let a compat registration masquerade as a typed one", async () => {
    const { vocabulary } = await discoverSteps(fixture("compat-project"), "features");
    for (const entry of vocabulary.values()) {
      expect(["typed", "compat"]).toContain(entry.kind);
    }
    expect(vocabulary.size).toBe(3);
  });

  it("throws DuplicateCompatStepError when two registrations share the same pattern source, regardless of keyword", async () => {
    await expect(
      discoverSteps(fixture("compat-duplicate-project"), "features"),
    ).rejects.toBeInstanceOf(DuplicateCompatStepError);
  });

  // tsx namespace isolation (src/compat/registry.ts's own header comment):
  // each discoverSteps() call gets its own tsx `register({ namespace })`,
  // and therefore its own instance of the compat registration buffer. Two
  // concurrent runs against the exact same fixture register the exact same
  // pattern text "at the same time" — if the buffers were shared, that
  // would either misattribute registrations to the wrong file or spuriously
  // trip DuplicateCompatStepError (the same pattern "twice"); neither
  // happens when isolation holds.
  it("keeps two concurrent discovery runs' compat registrations independent", async () => {
    const [first, second] = await Promise.all([
      discoverSteps(fixture("compat-project"), "features"),
      discoverSteps(fixture("compat-project"), "features"),
    ]);

    for (const { vocabulary } of [first, second]) {
      expect(vocabulary.size).toBe(3);
      expect([...vocabulary.keys()].sort()).toEqual(
        [
          "compat: a legacy project {string} exists",
          "compat: the legacy result is {string}",
          "compat: /^a legacy request is made$/",
        ].sort(),
      );
    }
  });

  // Proves the real package-resolution path, not just this repo's fixture-
  // only relative shim (see tests/fixtures/compat-project/nukadoko-compat-
  // shim.ts's own comment on why every *committed* fixture avoids the bare
  // specifier): the step file's content here is written at test run time,
  // never committed, so `tsc -p tsconfig.json`'s "tests/**/*.ts" glob never
  // sees this "nukadoko/compat" import at all.
  //
  // Run against the *built* `dist/cli.js` (via `node`, not `src/cli.ts` via
  // tsx — mirroring tests/cli.test.ts's own "nuka (process)" describe block,
  // one layer further down the stack): every temp project under
  // tests/.tmp-fixtures/ is nested inside this very package's own directory
  // tree, so Node's self-referencing package resolution
  // (https://nodejs.org/api/packages.html#self-referencing-a-package-using-its-name)
  // resolves a bare `"nukadoko/compat"` import through this repo's *own*
  // package.json `exports` map — unconditionally, before node_modules is
  // even consulted, so tests/helpers/fixtures.ts's `ensureNukadokoShim()`
  // shim is never actually reached for a project nested here. That map
  // points at `./dist/compat/index.js`: discovery must therefore run from
  // `dist/` too, so its own internal load of `../compat/registry.js`
  // resolves to the *same* compiled file the self-reference resolves to —
  // running `discoverSteps` from `src/` here (as every other test in this
  // file does) would silently split the two into independent module
  // instances with independent buffers, since compat's registration buffer
  // (unlike a typed Step's `Symbol.for` brand — src/step/brand.ts) is
  // ordinary module-closure state, not something that survives a src/dist
  // split. This is also why this one test needs `npm run build` to have
  // already produced `dist/cli.js` — the same pre-existing dependency
  // tests/examples-todo.test.ts's `ensureNukadokoShim()`-based tests already
  // have.
  it('resolves "nukadoko/compat" via the real published package (dist), not a fixture-only relative shim', async () => {
    const rootDir = await createEmptyTempDir();
    try {
      await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
      await writeFile(
        path.join(rootDir, "features", "steps", "bare-import.ts"),
        [
          'import { Given } from "nukadoko/compat";',
          "",
          'Given("a bare-imported compat step exists", function () {',
          "  return {};",
          "});",
          "",
        ].join("\n"),
      );

      const cliPath = path.join(repoRoot, "dist", "cli.js");
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [cliPath, "steps", "--json"],
        { cwd: rootDir },
      );

      expect(stderr).toBe("");
      const report = JSON.parse(stdout) as { steps: Array<Record<string, unknown>> };
      expect(report.steps).toEqual([
        expect.objectContaining({
          name: "compat: a bare-imported compat step exists",
          kind: "compat",
        }),
      ]);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
