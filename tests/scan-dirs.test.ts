import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `additionalFeatureDirs` end to end (fb3-scan-dirs task
// spec) — the config field that widens what `nuka check` (no argument) and
// `nuka tend` scan without adding anything to what `nuka run` (no argument)
// executes. Four things this task spec asks for, each with its own `it`
// block below: (1) it makes `pattern-unbound` stop misreporting a step bound
// only from an accepted feature outside `featuresDir`, with an unchanged
// regression case proving the unset default is untouched; (2) a configured-
// but-absent entry is reported, by both commands; (3) `nuka tend`'s bed
// output names what it scanned and counts read-only steps, in both text and
// `--json`; (4) `signed-feature-unscanned` makes a sign-off outside every
// scanned directory visible instead of silently feeding a false
// pattern-unbound elsewhere.

interface TendReport {
  errors: { code: string; message: string; file?: string; step?: string }[];
  notes: { code: string; message: string; file?: string; step?: string }[];
  summary: { scannedFeatureDirs: string[]; readOnlySteps: number; typedSteps: number; compatSteps: number };
}

interface CheckReport {
  errors: { code: string; message: string; file?: string }[];
  warnings: { code: string; message: string; file?: string }[];
}

async function runTend(rootDir: string): Promise<{ report: TendReport; exitCode: number }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["tend", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  return { report: JSON.parse(stdout.text()) as TendReport, exitCode };
}

async function runCheck(rootDir: string): Promise<{ report: CheckReport; exitCode: number }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  return { report: JSON.parse(stdout.text()) as CheckReport, exitCode };
}

describe("additionalFeatureDirs (fb3-scan-dirs)", () => {
  describe("nuka tend", () => {
    it("does not report pattern-unbound for a step bound only from an additionalFeatureDirs feature", async () => {
      const { report } = await runTend(fixture("tend-additional-dirs-project"));

      const unbound = report.notes.filter((issue) => issue.code === "pattern-unbound");
      expect(unbound.map((issue) => issue.step)).not.toContain("inspect-widget");
      expect(unbound.map((issue) => issue.step)).not.toContain("create-widget");
    });

    it("regression: the identical layout without additionalFeatureDirs still reports pattern-unbound", async () => {
      const { report } = await runTend(fixture("tend-additional-dirs-unset-project"));

      const unbound = report.notes.filter((issue) => issue.code === "pattern-unbound");
      expect(unbound.map((issue) => issue.step)).toContain("inspect-widget");
      expect(unbound.map((issue) => issue.step)).not.toContain("create-widget");
    });

    it("reports additional-feature-dir-missing for a configured-but-absent directory", async () => {
      const { report } = await runTend(fixture("tend-additional-dirs-project"));

      const missing = report.notes.filter((issue) => issue.code === "additional-feature-dir-missing");
      expect(missing).toHaveLength(1);
      expect(missing[0]!.file).toBe("ghost-dir");
      expect(missing[0]!.message).toContain("ghost-dir");
      // A note, not an error — a missing additionalFeatureDirs entry must
      // not fail `nuka tend`'s exit code (this task's spec, decision 2: only
      // sign-off rot is an error there).
      expect(report.errors).toEqual([]);
    });

    it("bed line: names the scanned directories and counts read-only steps, in text and --json", async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["tend"], {
        rootDir: fixture("tend-additional-dirs-project"),
        stdout,
        stderr: createCaptureSink(),
      });
      expect(exitCode).toBe(0);
      const lines = stdout.text().trim().split("\n");
      expect(lines[0]).toBe("scanned: features, accepted, ghost-dir");
      expect(lines[1]).toBe("bed: typed 2, compat 0, read-only 1");

      const { report } = await runTend(fixture("tend-additional-dirs-project"));
      expect(report.summary.scannedFeatureDirs).toEqual(["features", "accepted", "ghost-dir"]);
      expect(report.summary.readOnlySteps).toBe(1);
    });

    it("signed-feature-unscanned: fires for an accepted feature outside every scanned dir, not for one inside", async () => {
      const rootDir = await copyFixtureToTempDir("tend-signed-unscanned-project");
      try {
        await initGitRepo(rootDir);

        for (const featurePath of ["features/accepted-inside.feature", "elsewhere/accepted-outside.feature"]) {
          const runExit = await runCli(["run", featurePath], {
            rootDir,
            stdout: createCaptureSink(),
            stderr: createCaptureSink(),
          });
          expect(runExit).toBe(0);

          const acceptExit = await runCli(["accept", featurePath], {
            rootDir,
            stdout: createCaptureSink(),
            stderr: createCaptureSink(),
          });
          expect(acceptExit).toBe(0);
        }

        const { report } = await runTend(rootDir);
        const unscanned = report.notes.filter((issue) => issue.code === "signed-feature-unscanned");
        expect(unscanned).toHaveLength(1);
        expect(unscanned[0]!.file).toBe("elsewhere/accepted-outside.feature");
        expect(unscanned[0]!.message).toContain("elsewhere/accepted-outside.feature");
        expect(unscanned[0]!.message).toContain("additionalFeatureDirs");
      } finally {
        await removeTempDir(rootDir);
      }
    });
  });

  describe("nuka check", () => {
    it("scans additionalFeatureDirs with no feature argument", async () => {
      const { report, exitCode } = await runCheck(fixture("check-additional-dirs-project"));

      const undefinedSteps = report.errors.filter((issue) => issue.code === "undefined-step");
      const messages = undefinedSteps.map((issue) => issue.message).join("\n");
      expect(messages).toContain("this step is undefined inside featuresDir");
      expect(messages).toContain("this step is undefined outside featuresDir");
      expect(exitCode).toBe(1);
    });

    it("reports additional-feature-dir-missing for a configured-but-absent directory", async () => {
      const { report } = await runCheck(fixture("check-additional-dirs-project"));

      const missing = report.errors.filter((issue) => issue.code === "additional-feature-dir-missing");
      expect(missing).toHaveLength(1);
      expect(missing[0]!.file).toBe("ghost-dir");
      expect(missing[0]!.message).toContain("ghost-dir");
    });
  });
});
