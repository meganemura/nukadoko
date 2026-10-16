import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyExampleToTempDir, createCaptureSink, ensureNukadokoShim, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka check` reports explore-unknown-step and
// explore-browser-step with the file and the step name, says nothing about
// a request-only step, and does not run the steps. The fixture's model
// functions throw if they are called.

interface ExploreIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly step?: string;
}

async function checkReport(rootDir: string) {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr });
  return {
    exitCode,
    stderr: stderr.text(),
    report: JSON.parse(stdout.text()) as { errors: ExploreIssue[]; warnings: ExploreIssue[] },
  };
}

describe("nuka check: explore declarations", () => {
  it("exits 1 for an unknown step name and a browser step, and is silent for a request-only step", async () => {
    const { report, exitCode, stderr } = await checkReport(fixture("check-explore-project"));
    expect(stderr).toBe("");
    expect(exitCode).toBe(1);

    const unknown = report.errors.filter((issue) => issue.code === "explore-unknown-step");
    expect(unknown).toEqual([
      expect.objectContaining({
        file: "features/explore/unknown-model.ts",
        step: "missing-step",
      }),
    ]);
    expect(unknown[0]!.message).toContain("missing-step");
    expect(unknown[0]!.message).toContain("not in the vocabulary");

    const browser = report.errors.filter((issue) => issue.code === "explore-browser-step");
    expect(browser.map((issue) => issue.step).sort()).toEqual(["open-page", "open-page"]);
    for (const issue of browser) {
      expect(issue.file).toMatch(/^features\/explore\/browser-/);
      expect(issue.step).toBe("open-page");
      expect(issue.message).toContain("open-page");
      expect(issue.message).toContain("browser");
    }

    const request = report.errors.filter(
      (issue) =>
        (issue.code === "explore-unknown-step" || issue.code === "explore-browser-step") &&
        issue.file === "features/explore/request-model.ts",
    );
    expect(request).toEqual([]);
  });

  it("reports a model with no commands and a direct random call, and nothing for a quoted one", async () => {
    const { report } = await checkReport(fixture("check-explore-project"));
    const found = report.errors
      .filter((issue) => issue.code === "explore-empty-model" || issue.code === "explore-unseeded-random")
      .sort((a, b) => `${a.file}${a.step}${a.message}`.localeCompare(`${b.file}${b.step}${b.message}`));
    expect(found).toEqual([
      {
        code: "explore-empty-model",
        message: "the model has no commands, so every sequence it builds is empty and passes",
        file: "features/explore/empty-model.ts",
      },
      {
        code: "explore-unseeded-random",
        message:
          'command "add-todo" args calls Math.random(), which the seed does not drive, so a run cannot be replayed or shrunk. Use draw.int or draw.pick',
        file: "features/explore/random-model.ts",
        step: "add-todo",
      },
      {
        code: "explore-unseeded-random",
        message:
          'command "add-todo" next calls Math.random(), which the seed does not drive, so a run cannot be replayed or shrunk. Use draw.int or draw.pick',
        file: "features/explore/random-model.ts",
        step: "add-todo",
      },
    ]);
  });

  it("finds nothing to report in the todo example's model and relation", async () => {
    const rootDir = await copyExampleToTempDir("todo");
    try {
      await ensureNukadokoShim();
      const { report } = await checkReport(rootDir);
      expect([...report.errors, ...report.warnings].filter((issue) => issue.code.startsWith("explore-"))).toEqual([]);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
