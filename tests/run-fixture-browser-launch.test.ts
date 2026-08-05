import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: P5 task spec, scope item 5's own "page を要求しないシナ
// リオがブラウザを起動しないことを維持すること" — extended to the fixture
// era: a step that only destructures a fixture reaching `page` still
// launches exactly once; a step reaching neither `page` nor any such
// fixture never does. Same `chromium.launch` spy tests/run-fixture-bag-
// browser.test.ts already uses for the builtin-only case (p4a-fixture-bag
// task spec) — this file is that same measurement, one layer further out.

describe("nuka run: a step reaching page only through a fixture still launches exactly once", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("fixture-touches-browser-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("launches once for the fixture-reaching scenario, zero times for the other", async () => {
    const launchSpy = vi.spyOn(chromium, "launch");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "features/via-logged-in.feature"], { rootDir, stdout, stderr });

      expect(stderr.text()).toBe("");
      expect(exitCode).toBe(0);

      const records = stdout
        .text()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { status: string });
      expect(records).toHaveLength(2);
      expect(records[0]!.status).toBe("passed");
      expect(records[1]!.status).toBe("passed");

      expect(launchSpy).toHaveBeenCalledTimes(1);
    } finally {
      launchSpy.mockRestore();
    }
  });
});
