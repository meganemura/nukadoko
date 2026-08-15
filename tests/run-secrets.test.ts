import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: proves docs/spec.md "Secrets" reaches `nuka run`'s own
// artifacts — both the step's record.json *and* the owning scenario
// record.json — not just `nuka do`'s (already covered by tests/secrets.test.ts).
// leak-secret.ts throws with the secret value inside its own message, which
// flows into both the step record's own error.message and
// record.steps[].error.message; the record is
// redacted once, as a whole object, exactly like a step record.

const API_TOKEN = "sekrit-value-123";

describe("nuka run: secret redaction", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-secrets-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("redacts the secret value from both the scenario record and the step's own step record", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/leak.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).not.toContain(API_TOKEN);

    const lines = stdout.text().split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);

    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toContain("{{secret.API_TOKEN}}");
    expect(record.steps[0].error.message).not.toContain(API_TOKEN);
    expect(stdout.text()).not.toContain(API_TOKEN);

    const recordPath = path.join(rootDir, record.evidence.dir, "record.json");
    const recordText = await readFile(recordPath, "utf8");
    expect(recordText).toContain("{{secret.API_TOKEN}}");
    expect(recordText).not.toContain(API_TOKEN);

    const stepRecordPath = path.join(
      rootDir,
      ".nukadoko",
      "records",
      "steps",
      record.steps[0].record,
      "record.json",
    );
    const stepRecordText = await readFile(stepRecordPath, "utf8");
    expect(stepRecordText).toContain("{{secret.API_TOKEN}}");
    expect(stepRecordText).not.toContain(API_TOKEN);
  });
});
