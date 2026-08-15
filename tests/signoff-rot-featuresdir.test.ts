import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: src/tend/signoff-rot.ts's own featuresDir placement skip —
// a record whose frozen feature lives inside `featuresDir` is silenced
// entirely, one whose feature merely shares `featuresDir`'s name as a string
// prefix ("features-extra" against `featuresDir` "features") must not be. The
// unreadable-record exception to this skip
// (`signoff-record-unreadable` fires regardless of placement, since a broken
// record's own claimed feature path cannot be trusted) already has its own
// coverage in tests/signoff-rot.test.ts's "reports an unparseable record...
// even though the file itself sits inside featuresDir" case, not repeated
// here.

interface Report {
  errors: { code: string; file?: string }[];
  notes: { code: string; file?: string }[];
}

async function runTend(rootDir: string): Promise<{ report: Report; exitCode: number }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["tend", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  return { report: JSON.parse(stdout.text()) as Report, exitCode };
}

describe("nuka tend: sign-off rot's featuresDir placement skip", () => {
  let rootDir: string;
  let insideRecordPath: string;
  let nearMissRecordPath: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("tend-signoff-featuresdir-project");
    await initGitRepo(rootDir);

    for (const featurePath of ["features/inside.feature", "features-extra/near-miss.feature"]) {
      const runExit = await runCli(["run", featurePath], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(runExit).toBe(0);

      const acceptStdout = createCaptureSink();
      const acceptExit = await runCli(["accept", featurePath], {
        rootDir,
        stdout: acceptStdout,
        stderr: createCaptureSink(),
      });
      expect(acceptExit).toBe(0);
      if (featurePath === "features/inside.feature") {
        insideRecordPath = acceptStdout.text().trim();
      } else {
        nearMissRecordPath = acceptStdout.text().trim();
      }
    }
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("reports nothing for either record while both stay untouched", async () => {
    const { report, exitCode } = await runTend(rootDir);
    expect(report.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("stays silent for the record inside featuresDir once its feature changes, but still reports the one in a near-miss directory", async () => {
    const insideFeaturePath = path.join(rootDir, "features", "inside.feature");
    const insideOriginal = await readFile(insideFeaturePath, "utf8");
    await writeFile(insideFeaturePath, insideOriginal.replace("a thing happens", "a thing happens differently"));

    const nearMissFeaturePath = path.join(rootDir, "features-extra", "near-miss.feature");
    const nearMissOriginal = await readFile(nearMissFeaturePath, "utf8");
    await writeFile(nearMissFeaturePath, nearMissOriginal.replace("a thing happens", "a thing happens differently"));

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(1);

    // Nothing at all about the inside record — not signoff-feature-changed,
    // not any other code, not even under a different code.
    expect(report.errors.some((e) => e.file === insideRecordPath)).toBe(false);
    expect(report.notes.some((n) => n.file === insideRecordPath)).toBe(false);

    // The near-miss record still reports, proving the silence above is
    // about featuresDir placement, not a fixture-wide fluke.
    const changed = report.errors.filter((e) => e.code === "signoff-feature-changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.file).toBe(nearMissRecordPath);
  });

  it("stays silent for the record inside featuresDir even once its cited step disappears, but still reports the one in a near-miss directory", async () => {
    // Both records cite the same step ("a thing happens", this fixture's
    // own header) — deleting its glue file makes it missing from the
    // vocabulary for both, so this is the same skip proven again against a
    // different one of signoff-rot.ts's own checks ((c), not (b) above).
    await rm(path.join(rootDir, "features", "steps", "thing-happens.ts"));

    const { report, exitCode } = await runTend(rootDir);
    expect(exitCode).toBe(1);

    expect(report.errors.some((e) => e.file === insideRecordPath)).toBe(false);

    const missing = report.errors.filter((e) => e.code === "signoff-step-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.file).toBe(nearMissRecordPath);
  });
});
