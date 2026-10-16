import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

describe("nuka tend: schema-field-undescribed under wrappers", () => {
  it("counts a description kept on the inner schema of every wrapper", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json", "--all"], {
      rootDir: fixture("tend-wrapped-describe-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text());
    const undescribed = report.notes.filter(
      (issue: { code: string }) => issue.code === "schema-field-undescribed",
    );
    expect(undescribed).toHaveLength(1);
    expect(undescribed[0].message).toContain("Step \"wrapped-fields\" has schema fields with no .describe(): returns.bare.");
    expect(report.summary.describe).toEqual({ declared: 8, total: 9 });
  });
});
