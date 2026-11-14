import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: `additionalFeatureDirs` end to end, the config field
// that widens what `nuka check` (no argument) scans without adding anything
// to what `nuka run` (no argument) executes. Covered here: (1) it makes the
// `pattern-unbound` note stop misreporting a step bound only from a feature
// outside `featuresDir`, with an unchanged regression case proving the unset
// default is untouched; (2) a configured-but-absent entry is reported once,
// as an error; (3) the note names the directories it scanned.

interface CheckReport {
  errors: { code: string; message: string; file?: string; step?: string }[];
  warnings: { code: string; message: string; file?: string }[];
  notes: { code: string; message: string; file?: string; step?: string }[];
}

async function runCheck(rootDir: string): Promise<{ report: CheckReport; exitCode: number }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  return { report: bySeverity(stdout.text()) as CheckReport, exitCode };
}

describe("additionalFeatureDirs", () => {
  describe("the pattern-unbound note", () => {
    it("is not reported for a step bound only from an additionalFeatureDirs feature", async () => {
      const { report } = await runCheck(fixture("check-notes-additional-dirs-project"));

      const unbound = report.notes.filter((issue) => issue.code === "pattern-unbound");
      expect(unbound.map((issue) => issue.step)).not.toContain("inspect-widget");
      expect(unbound.map((issue) => issue.step)).not.toContain("create-widget");
    });

    it("regression: the identical layout without additionalFeatureDirs still reports it, naming the one scanned directory", async () => {
      const { report } = await runCheck(fixture("check-notes-additional-dirs-unset-project"));

      const unbound = report.notes.filter((issue) => issue.code === "pattern-unbound");
      expect(unbound.map((issue) => issue.step)).toEqual(["inspect-widget"]);
      expect(unbound[0]!.message).toContain("under the scanned directories (features) binds it");
    });

    it("leaves a configured-but-absent directory to the error, which is reported once", async () => {
      const { report } = await runCheck(fixture("check-notes-additional-dirs-project"));
      expect(report.notes.map((issue) => issue.code)).not.toContain("additional-feature-dir-missing");
      expect(report.errors.filter((issue) => issue.code === "additional-feature-dir-missing").map((issue) => issue.file)).toEqual([
        "ghost-dir",
      ]);
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
      expect(missing[0]).toMatchObject({
        fix: 'Create ghost-dir, or remove "ghost-dir" from additionalFeatureDirs in nukadoko.config.ts.',
      });
    });
  });
});
