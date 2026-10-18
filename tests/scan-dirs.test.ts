import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: `additionalFeatureDirs` end to end — the config field
// that widens what `nuka check` (no argument) and
// `nuka tend` scan without adding anything to what `nuka run` (no argument)
// executes. Three things are covered here, each with its own `it`
// block below: (1) it makes `pattern-unbound` stop misreporting a step bound
// only from a feature outside `featuresDir`, with an unchanged
// regression case proving the unset default is untouched; (2) a configured-
// but-absent entry is reported, by both commands; (3) `nuka tend`'s bed
// output names what it scanned and counts read-only steps, in both text and
// `--json`.

interface TendReport {
  errors: { code: string; message: string; file?: string; step?: string }[];
  notes: { code: string; message: string; file?: string; step?: string }[];
  summary: { scanned_feature_dirs: string[]; read_only_steps: number; typed_steps: number; compat_steps: number };
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
  return { report: bySeverity(stdout.text()) as TendReport, exitCode };
}

async function runCheck(rootDir: string): Promise<{ report: CheckReport; exitCode: number }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  return { report: bySeverity(stdout.text()) as CheckReport, exitCode };
}

describe("additionalFeatureDirs", () => {
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

    it("leaves a configured-but-absent directory to nuka check, which reports it once", async () => {
      const { report } = await runTend(fixture("tend-additional-dirs-project"));
      expect(report.notes.map((issue) => issue.code)).not.toContain("additional-feature-dir-missing");
      expect(report.errors).toEqual([]);

      const { report: checked } = await runCheck(fixture("tend-additional-dirs-project"));
      expect(checked.errors.filter((issue) => issue.code === "additional-feature-dir-missing").map((issue) => issue.file)).toEqual([
        "ghost-dir",
      ]);
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
      expect(lines[0]).toBe("scanned: features, extra, ghost-dir");
      expect(lines[1]).toBe("bed: typed 2, compat 0, read-only 1");

      const { report } = await runTend(fixture("tend-additional-dirs-project"));
      expect(report.summary.scanned_feature_dirs).toEqual(["features", "extra", "ghost-dir"]);
      expect(report.summary.read_only_steps).toBe(1);
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
