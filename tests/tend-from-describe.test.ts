import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

describe("nuka tend: schema-field-undescribed on args that from fills", () => {
  it("reads a from-filled arg's description from its producer's returns field", async () => {
    const stdout = createCaptureSink();
    await runCli(["tend", "--json"], {
      rootDir: fixture("tend-from-describe-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = bySeverity(stdout.text());
    const messages = report.notes
      .filter((issue: { code: string }) => issue.code === "schema-field-undescribed")
      .map((issue: { message: string }) => issue.message.split(". ")[0])
      .sort();
    expect(messages).toEqual([
      'Step "make-scratch" has schema fields with no .describe(): returns.label',
      'Step "use-scratch" has schema fields with no .describe(): args.label',
    ]);
    expect(report.summary.describe).toEqual({ declared: 2, total: 4 });
  });
});
