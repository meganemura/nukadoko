import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { missingTsSourceSentence } from "../src/check/missing-ts-source.js";
import { runCli } from "../src/cli/run-cli.js";
import {
  createCaptureSink,
  createEmptyTempDir,
  ensureNukadokoShim,
  fixture,
  removeTempDir,
} from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: `step-file-import-
// failed` findings get `CheckIssue.line` filled in when (and only when) the
// underlying message itself already names a position, extracted rather than
// re-derived some other way (message stays verbatim either way).
//
// tests/fixtures/check-import-failure-location-project has one step file
// (broken.ts) whose own fixture-bag name (`page`) is redeclared directly
// under the function it's destructured into: an early ECMAScript error V8
// raises while compiling the module, before this step's `run()` body ever
// executes. Its stack names no location, so the line comes from the child
// probe in src/discover/import-failure.ts. `// @ts-nocheck` at that file's
// own top keeps the same redeclaration from *also* being a `tsc` error
// under `npm run typecheck` (tsconfig.json's own include is
// "tests/**/*.ts", which reaches fixtures too).
//
// tests/fixtures/check-import-failure-location-shared-project has the same
// broken.ts plus a second file (via-import.ts) that only side-effect
// imports it: Node's ESM loader caches broken.ts's failure and rethrows the
// identical error to via-import.ts too, so the two entries share one
// message byte-for-byte, but that message's own location names broken.ts's
// path, never via-import.ts's.
//
// tests/fixtures/check-import-failure-project (require()-in-ESM, an
// existing fixture) is reused for the location-less case: Node's own
// ESM-loader error carries no location at all.

describe("nuka check: step-file-import-failed carries a line when the message has one", () => {
  it("fills line from a compile error's location in the step file itself", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-location-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text()) as {
      errors: Array<{ code: string; file?: string; line?: number; message: string }>;
    };
    const brokenIssue = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(brokenIssue).toBeDefined();
    expect(brokenIssue?.file).toBe("features/steps/broken.ts");
    expect(brokenIssue?.message).toBe("Identifier 'page' has already been declared (features/steps/broken.ts:22)");
    // Line 22 of this fixture file is `const page = 1;`.
    expect(brokenIssue?.line).toBe(22);
    expect(exitCode).toBe(1);
  });

  it("human-readable output prints file:line for this ungrouped single-file case", async () => {
    const stdout = createCaptureSink();
    await runCli(["check"], {
      rootDir: fixture("check-import-failure-location-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const text = stdout.text();
    expect(text).toContain("features/steps/broken.ts:22\t");
  });

  it("does not fill line, and the message is unchanged, for a location-less Node ESM error", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text()) as {
      errors: Array<{ code: string; file?: string; line?: number; message: string }>;
    };
    const importIssue = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(importIssue).toBeDefined();
    expect(importIssue?.message).toContain("require is not defined");
    expect(importIssue?.line).toBeUndefined();
    expect(exitCode).toBe(1);
  });

  it("does not fill line when the message's location names a different file (rethrown import)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-location-shared-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = bySeverity(stdout.text()) as {
      errors: Array<{ code: string; file?: string; line?: number; message: string }>;
    };
    const importFailures = report.errors.filter((issue) => issue.code === "step-file-import-failed");
    expect(importFailures).toHaveLength(2);

    const brokenIssue = importFailures.find((issue) => issue.file === "features/steps/broken.ts");
    const viaImportIssue = importFailures.find((issue) => issue.file === "features/steps/via-import.ts");
    expect(brokenIssue).toBeDefined();
    expect(viaImportIssue).toBeDefined();

    // Both share the identical message (Node's ESM loader rethrows the
    // cached failure verbatim) — the location it names is broken.ts's own,
    // so only broken.ts's own entry gets `line`.
    expect(brokenIssue?.message).toBe(viaImportIssue?.message);
    // This project's own broken.ts has one extra comment line naming
    // via-import.ts, so the redeclaration sits on line 23 here (measured
    // directly), not the 22 the standalone location-project's copy has.
    expect(brokenIssue?.line).toBe(23);
    expect(viaImportIssue?.line).toBeUndefined();
    expect(exitCode).toBe(1);
  });

  it("grouped human-readable display never prints a line, even though one member's own entry has one", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check"], {
      rootDir: fixture("check-import-failure-location-shared-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const text = stdout.text();
    const importFailedLines = text.split("\n").filter((line) => line.startsWith("error\tstep-file-import-failed"));
    // One grouped line for both files sharing the message, never two
    // separate lines (the same fold tests/check-import-failure-grouping
    // .test.ts already exercises for a location-less shared message).
    expect(importFailedLines).toHaveLength(1);

    const grouped = importFailedLines[0];
    expect(grouped).toContain("(2 files)");
    // Never a stray ":<number>" tacked onto the "(2 files)" column: a
    // message shared across files can't say which one file a location
    // inside it belongs to, even when (as here) one of the two members'
    // own CheckIssue *does* carry a `line` (the JSON-level test above
    // proves that) — src/cli/check.ts's own `formatImportFailureGroup`
    // never reads `line` once there is more than one file in the group.
    expect(grouped).not.toMatch(/\(2 files\):\d/);
    expect(exitCode).toBe(1);
  });
});

// A relative `.js` import whose `.ts` file was renamed or deleted: Node's
// text names the `.js` path, absolute, so the finding appends the `.ts` file
// it stood for and the file whose import to edit, both root-relative.
describe("nuka check: step-file-import-failed names the .ts file a missing .js import stands for", () => {
  const producer = [
    'import { z } from "zod";',
    'import { defineStep } from "nukadoko";',
    "",
    "export default defineStep({",
    '  pattern: "I run greet",',
    '  description: "Runs greet",',
    "  args: z.object({}),",
    "  returns: z.object({ stdout: z.string() }),",
    "  async run() {",
    '    return { stdout: "" };',
    "  },",
    "});",
    "",
  ].join("\n");
  const consumer = (specifier: string) =>
    [
      'import { z } from "zod";',
      'import { defineStep } from "nukadoko";',
      `import runGreet from ${JSON.stringify(specifier)};`,
      "",
      "export default defineStep({",
      '  pattern: "the output says {text:string}",',
      '  description: "Reads the output",',
      "  args: z.object({ text: z.string() }),",
      "  returns: z.object({}),",
      "  mutates: false,",
      "  from: { text: runGreet },",
      "  async run() {",
      "    return {};",
      "  },",
      "});",
      "",
    ].join("\n");

  async function projectWith(files: Record<string, string>): Promise<string> {
    await ensureNukadokoShim();
    const dir = await createEmptyTempDir();
    await mkdir(path.join(dir, "features", "steps"), { recursive: true });
    await writeFile(path.join(dir, "nukadoko.config.ts"), 'import { defineConfig } from "nukadoko";\nexport default defineConfig({});\n');
    for (const [name, text] of Object.entries(files)) {
      await writeFile(path.join(dir, "features", "steps", name), text);
    }
    return dir;
  }

  async function importFailures(dir: string): Promise<Array<{ file?: string; message: string }>> {
    const stdout = createCaptureSink();
    await runCli(["check", "--json"], { rootDir: dir, stdout, stderr: createCaptureSink() });
    const report = bySeverity(stdout.text()) as { errors: Array<{ code: string; file?: string; message: string }> };
    return report.errors
      .filter((issue) => issue.code === "step-file-import-failed")
      .map(({ file, message }) => ({ file, message }));
  }

  it("a renamed producer: names features/steps/run-greet.ts and the consumer to edit", async () => {
    const dir = await projectWith({ "run-cli.ts": producer, "output-says.ts": consumer("./run-greet.js") });
    try {
      const failures = await importFailures(dir);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.file).toBe("features/steps/output-says.ts");
      expect(failures[0]!.message).toBe(
        `Cannot find module '${path.join(dir, "features/steps/run-greet.js")}' imported from ${path.join(dir, "features/steps/output-says.ts")}` +
          "; features/steps/run-greet.js stands for features/steps/run-greet.ts, which does not exist; update the import in features/steps/output-says.ts",
      );
    } finally {
      await removeTempDir(dir);
    }
  });

  it("a deleted producer, imported from a parent-relative path: the same sentence", async () => {
    const dir = await projectWith({ "output-says.ts": consumer("../steps/run-greet.js") });
    try {
      const failures = await importFailures(dir);
      expect(failures.map((failure) => failure.message.slice(failure.message.indexOf("; ")))).toEqual([
        "; features/steps/run-greet.js stands for features/steps/run-greet.ts, which does not exist; update the import in features/steps/output-says.ts",
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("a missing package gets Node's text alone", async () => {
    const dir = await projectWith({ "output-says.ts": consumer("no-such-package-anywhere") });
    try {
      const failures = await importFailures(dir);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.message).toContain("Cannot find package 'no-such-package-anywhere'");
      expect(failures[0]!.message).not.toContain("stands for");
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("missingTsSourceSentence", () => {
  const root = path.resolve("/project");
  const at = (relative: string) => path.join(root, relative);
  const nodeText = (missing: string, importer: string, eol = "") =>
    `Cannot find module '${missing}' imported from ${importer}${eol}`;

  it("appends nothing when the .ts file exists, so the cause is something else", () => {
    const message = nodeText(at("features/steps/a.js"), at("features/steps/b.ts"));
    expect(missingTsSourceSentence(message, root, (file) => file === at("features/steps/a.ts"))).toBe("");
  });

  it("maps .mjs to .mts", () => {
    const message = nodeText(at("features/steps/a.mjs"), at("features/steps/b.mts"));
    expect(missingTsSourceSentence(message, root, () => false)).toBe(
      "; features/steps/a.mjs stands for features/steps/a.mts, which does not exist; update the import in features/steps/b.mts",
    );
  });

  it("stops the importer at a CRLF line ending", () => {
    const message = nodeText(at("features/steps/a.js"), at("features/steps/b.ts"), "\r\n    at resolve (node:internal)");
    expect(missingTsSourceSentence(message, root, () => false)).toBe(
      "; features/steps/a.js stands for features/steps/a.ts, which does not exist; update the import in features/steps/b.ts",
    );
  });

  it("appends nothing for a file inside node_modules or a non-JavaScript extension", () => {
    expect(
      missingTsSourceSentence(nodeText(at("node_modules/pkg/x.js"), at("features/steps/b.ts")), root, () => false),
    ).toBe("");
    expect(missingTsSourceSentence(nodeText(at("features/steps/a.json"), at("features/steps/b.ts")), root, () => false)).toBe("");
  });

  it("names the source file exactly when it is absent, for any name and extension", () =>
    hegel.test((tc) => {
      const name = tc.draw(gs.sampledFrom(["run-greet", "a", "step.v2", "deep/nested/step"]));
      const [jsExt, tsExt] = tc.draw(
        gs.sampledFrom([
          [".js", ".ts"],
          [".mjs", ".mts"],
          [".cjs", ".cts"],
        ] as const),
      );
      const present = tc.draw(gs.booleans());
      const eol = tc.draw(gs.sampledFrom(["", "\n", "\r\n"]));
      const source = at(`features/steps/${name}${tsExt}`);
      const message = nodeText(at(`features/steps/${name}${jsExt}`), at("features/steps/importer.ts"), eol);
      const sentence = missingTsSourceSentence(message, root, (file) => present && file === source);
      if (present) {
        expect(sentence).toBe("");
      } else {
        expect(sentence).toBe(
          `; features/steps/${name}${jsExt} stands for features/steps/${name}${tsExt}, which does not exist; update the import in features/steps/importer.ts`,
        );
      }
    }));
});
