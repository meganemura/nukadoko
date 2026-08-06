import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: p6-browser-type task spec's own end-to-end proof —
// `config.browserType` reaching a real `nuka run`, and the measured
// `ScenarioRecord.browser` it leaves behind. Reuses run-browser-project's
// existing features/no-browser.feature (tests/run-fixture-bag-browser.test.ts
// already exercises it for a different question, "did chromium.launch get
// called") because it already pairs a scenario that never destructures
// `page` with one that does, in a single file, which is exactly the
// pageless/page-naming contrast this task's own tests need: "browser キー
// が出ない" and "browser にエンジン名とバージョンが入る" are two readings of
// the same two records. Deliberately limited to explicitly choosing
// "chromium" (this task's spec: "テストは chromium だけで書けるように設計
// すること") — firefox/webkit have no binary installed in this environment
// by the task's own instruction, and rejecting an unknown `browserType`
// value needs no `nuka run` at all (see tests/load-config.test.ts).

interface StoredRecord {
  readonly status: string;
  readonly browser?: { readonly type: string; readonly version: string };
}

describe("nuka run: browserType", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-browser-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it('runs exactly as before when browserType is explicitly "chromium", recording the measured engine and version only for the scenario that launched one', async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        'export default defineConfig({ browserType: "chromium" });',
        "",
      ].join("\n"),
    );

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/no-browser.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(stripRunProgressLines(stderr.text())).toBe("");
    expect(exitCode).toBe(0);

    const records = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as StoredRecord);
    expect(records).toHaveLength(2);

    const [pageLess, pageNaming] = records;
    expect(pageLess!.status).toBe("passed");
    expect(pageNaming!.status).toBe("passed");

    // "書かなければ今と完全に同じ挙動" (this task's spec) extends to writing
    // "chromium" explicitly too: a pickle that never destructures `page`
    // launches nothing, so its own record carries no `browser` key at all —
    // never a key naming a browser that never ran.
    expect(pageLess!.browser).toBeUndefined();
    expect(Object.keys(pageLess!)).not.toContain("browser");

    // The other scenario's own step does destructure `page`, so its record
    // carries the measured engine and version chromium actually reported —
    // not the declared "chromium" echoed back.
    expect(pageNaming!.browser?.type).toBe("chromium");
    expect(typeof pageNaming!.browser?.version).toBe("string");
    expect(pageNaming!.browser?.version).not.toBe("");
  });
});
