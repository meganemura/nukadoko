import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: m2b-compat-execution task spec's World + Before/After hook
// coverage — `setWorldConstructor` with a custom field, the unopened-getter
// error, tag-filtered hooks (including `not @tag`), a failing Before
// skipping every step while `record.hooks` still shows it, After running
// regardless, and an unsupported tag expression failing setup outright.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run: World + Before/After hooks", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-world-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("Before hooks (untagged, not-@excluded, @tagged) set state on the custom World a later step reads", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/world-hooks.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    // The @before-fails scenario in this same file fails on purpose (its
    // own test below) — this run's own exit code reflects that, but every
    // other scenario's own record still passed.
    expect(exitCode).toBe(1);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(4);

    const untagged = records.find((r) => r.scenario.startsWith("an untagged scenario"));
    const tagged = records.find((r) => r.scenario.startsWith("a @tagged scenario"));
    const excluded = records.find((r) => r.scenario.startsWith("an @excluded scenario"));

    // untagged Before (+1) + not-@excluded Before (+10): the @tagged hook
    // does not apply (no @tagged tag on this scenario).
    expect(untagged.status).toBe("passed");
    expect(untagged.hooks.filter((h: { type: string }) => h.type === "before")).toHaveLength(2);

    // untagged (+1) + @tagged (+100) + not-@excluded (+10) = 111.
    expect(tagged.status).toBe("passed");
    expect(tagged.hooks.filter((h: { type: string }) => h.type === "before")).toHaveLength(3);

    // @excluded scenario: the not-@excluded hook does not apply (tag
    // matches its own negation's exclusion) — only the untagged hook (+1).
    expect(excluded.status).toBe("passed");
    expect(excluded.hooks.filter((h: { type: string }) => h.type === "before")).toHaveLength(1);

    // Every scenario in this feature also gets the untagged After hook
    // (this task's spec, item 5: After always attempts to run).
    for (const record of [untagged, tagged, excluded]) {
      expect(record.hooks.filter((h: { type: string }) => h.type === "after")).toEqual([
        { type: "after", status: "ok" },
      ]);
    }
  });

  it("a failing Before hook skips every step; record.hooks shows the failure, and After still runs", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/world-hooks.feature:15"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);

    expect(record.scenario).toBe("a failing Before hook skips every step");
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].status).toBe("skipped");
    expect(record.steps[0].receipt).toBeNull();

    const beforeHooks = record.hooks.filter((h: { type: string }) => h.type === "before");
    expect(beforeHooks.some((h: { status: string }) => h.status === "failed")).toBe(true);
    const failedBeforeHook = beforeHooks.find((h: { status: string }) => h.status === "failed");
    expect(failedBeforeHook.error.message).toBe("before hook exploded");

    // After still ran despite the Before failure.
    expect(record.hooks).toContainEqual({ type: "after", status: "ok" });
  });

  it("accessing this.page before openPage() resolves fails clearly (WorldNotOpenedError), and attach/log/link are held without crashing", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/unopened-getter.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    const [unopened, heldDeclarations] = records;

    expect(unopened.steps[0].status).toBe("failed");
    expect(unopened.steps[0].error.message).toContain("openPage()");
    expect(unopened.steps[0].error.message).toContain("await this.openPage()");

    const receiptPath = path.join(
      rootDir,
      ".nukadoko",
      "receipts",
      unopened.steps[0].receipt,
      "receipt.json",
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(receipt.status).toBe("failed");

    // attach/log/link are received, not dropped (this task's spec, item 1)
    // — calling all three must not crash existing glue on import switch.
    expect(heldDeclarations.status).toBe("passed");
    expect(heldDeclarations.steps[0].status).toBe("passed");
  });
});

describe("nuka run: unsupported hook tag expression is a setup failure", () => {
  it("exits 1 with a message naming the unsupported expression; nothing is written", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/noop.feature"], {
      rootDir: fixture("compat-bad-tag-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("@a and @b");
    expect(stderr.text()).toContain("Unsupported");
    expect(existsSync(path.join(fixture("compat-bad-tag-project"), ".nukadoko"))).toBe(false);
  });
});
