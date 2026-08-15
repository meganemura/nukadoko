import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  initGitRepo,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: `nuka tend`'s `post-navigation-read` note (fb5-stale-wait-
// note task spec) end to end. One test runs a real chromium navigation
// followed immediately by a real `expect()` call (tests/fixtures/
// trace-actions-project's own `wait-for-late-element` step, already proven
// by tests/trace-actions-expect.test.ts to produce a real trace with both
// calls) through `nuka run` + `nuka accept`, then `nuka tend`, so the note's
// own gap math runs against an actual measured step record at least once,
// per this task's spec ("推測で書かない"). The rest hand-craft an acceptance
// record's own text directly (the same pattern tests/
// signoff-condition-mismatch.test.ts already uses for its own "an old
// record has no condition to compare" case): these exist only to pin down
// this finding's own boundary math (a gap far enough apart, a step record
// with no `actions` at all, a step with no navigation call), which does not need
// a second browser launch to prove.

const LATE_ELEMENT_DELAY_MS = 600;

function startLateElementServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        [
          "<html><body>",
          "<script>",
          "setTimeout(() => {",
          '  const el = document.createElement("div");',
          '  el.id = "late";',
          '  el.textContent = "late";',
          "  document.body.appendChild(el);",
          `}, ${LATE_ELEMENT_DELAY_MS});`,
          "</script>",
          "</body></html>",
        ].join("\n"),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

interface Report {
  errors: { code: string }[];
  notes: { code: string; message: string; file?: string; step?: string }[];
}

async function runTendJson(rootDir: string): Promise<{ report: Report; exitCode: number }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(["tend", "--json"], { rootDir, stdout, stderr });
  expect(stderr.text()).toBe("");
  return { report: JSON.parse(stdout.text()) as Report, exitCode };
}

const COMMIT = "0".repeat(40);

/** A hand-assembled acceptance record, matching src/accept/render-record.ts's
 * own shape closely enough for src/tend/record-parse.ts to accept it: valid
 * frontmatter (the four required keys), a "## The scenario as it ran"
 * fenced feature, and one `#### <step>` fenced JSON step record. Only what
 * this finding's own boundary tests need varies: `stepRecord` is passed
 * straight through to `JSON.stringify`, so its own `actions` (or lack of one) is
 * exactly what src/tend/post-navigation-read.ts reads. */
function buildRecord(options: { featurePath: string; stepText: string; stepRecord: Record<string, unknown> }): string {
  const { featurePath, stepText, stepRecord } = options;
  return [
    "---",
    "run_id: run-synthetic",
    `commit: ${COMMIT}`,
    `feature: ${featurePath}`,
    "ran_at: 2026-01-01T00:00:00.000Z",
    "accepted_at: 2026-01-01T00:00:00.000Z",
    "environment: default",
    "browser: none",
    "scenarios:",
    "  - name: a synthetic scenario",
    "    line: 2",
    "    scenario_id: scn-synthetic",
    "---",
    "",
    "# Synthetic: green at 0000000",
    "",
    "## The scenario as it ran",
    "",
    "```gherkin",
    "Feature: Synthetic",
    "  Scenario: a synthetic scenario",
    `    Given ${stepText}`,
    "```",
    "",
    "## What the tool measured",
    "",
    "### a synthetic scenario (line 2)",
    "",
    `#### ${stepText}`,
    "",
    "```json",
    JSON.stringify(stepRecord, null, 2),
    "```",
    "",
  ].join("\n");
}

describe("nuka tend: post-navigation-read (fb5-stale-wait-note)", () => {
  describe("a real chromium step record", () => {
    let server: Server;
    let baseURL: string;
    let rootDir: string;

    beforeEach(async () => {
      ({ server, baseURL } = await startLateElementServer());
      rootDir = await copyFixtureToTempDir("trace-actions-project");
      await writeFile(
        path.join(rootDir, "nukadoko.config.ts"),
        [
          'import { defineConfig } from "./nukadoko-shim.js";',
          `export default defineConfig({ baseURL: "${baseURL}" });`,
          "",
        ].join("\n"),
      );
      // Matches tests/fixtures/tend-signoff-project's own .gitignore:
      // `.nukadoko` itself (evidence, step records) and any generated record
      // must never show up as "untracked" once `nuka run` has produced
      // them, or `nuka accept`'s own dirty-tree check refuses every time.
      await writeFile(path.join(rootDir, ".gitignore"), [".nukadoko/", "features/*.md", ""].join("\n"));
      // Committed with the config already in place: `nuka accept` refuses
      // on a dirty tree, and the config must exist before `initGitRepo`'s
      // own `git add -A` for it to ever be tracked at all.
      await initGitRepo(rootDir);
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeTempDir(rootDir);
    });

    it("reports the gap between a real goto and the very next call, without failing the run", async () => {
      const runExit = await runCli(["run", "features/wait-for-late-element.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(runExit).toBe(0);

      const acceptStdout = createCaptureSink();
      const acceptExit = await runCli(["accept", "features/wait-for-late-element.feature"], {
        rootDir,
        stdout: acceptStdout,
        stderr: createCaptureSink(),
      });
      expect(acceptExit).toBe(0);
      const recordPath = acceptStdout.text().trim();

      const { report, exitCode } = await runTendJson(rootDir);
      // A note never sets tend's own exit code (this task's spec, item 4).
      expect(exitCode).toBe(0);

      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.file).toBe(recordPath);
      expect(notes[0]!.step).toBe("wait-for-late-element");
      expect(notes[0]!.message).toContain('"goto"');
      expect(notes[0]!.message).toContain('"expect"');
      // The step's own two calls (`await page.goto(...)` then
      // `await expect(...)`) run back to back with nothing in between, so
      // the real, measured gap is small: well inside the cutoff this
      // finding uses to decide whether listing it is still worth a reader's
      // attention.
      const [, gapMsText] = /(\d+)ms after its own/.exec(notes[0]!.message) ?? [];
      expect(gapMsText).toBeDefined();
      expect(Number(gapMsText)).toBeGreaterThanOrEqual(0);
      expect(Number(gapMsText)).toBeLessThan(10_000);
      // Not a verdict (this task's spec, item 3, "断定しない"), the same
      // wording fixture-touches-app.ts's own note already uses.
      expect(notes[0]!.message).toContain("Not a judgment");
    });
  });

  describe("a hand-crafted record", () => {
    let rootDir: string;

    beforeEach(async () => {
      rootDir = await copyFixtureToTempDir("tend-clean-project");
    });

    afterEach(async () => {
      await removeTempDir(rootDir);
    });

    it("reports nothing when the next call is far enough from the navigation's own end", async () => {
      await writeFile(
        path.join(rootDir, "far-apart.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step with a wide gap",
          stepRecord: {
            step: "a step with a wide gap",
            status: "ok",
            actions: [
              { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
              // 2026-01-01T00:00:20.050Z minus (00:00.000Z + 50ms) = 20000ms,
              // twice this finding's own 10s cutoff.
              { method: "click", at: "2026-01-01T00:00:20.050Z", ms: 5 },
            ],
          },
        }),
      );

      const { report } = await runTendJson(rootDir);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });

    it("reports nothing, and does not throw, for a step record with no actions field at all", async () => {
      await writeFile(
        path.join(rootDir, "no-actions.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step accepted before actions existed",
          stepRecord: {
            step: "a step accepted before actions existed",
            status: "ok",
          },
        }),
      );

      const { report } = await runTendJson(rootDir);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });

    it("reports nothing for a step whose actions never include a navigation call", async () => {
      await writeFile(
        path.join(rootDir, "no-navigation.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step that never navigates",
          stepRecord: {
            step: "a step that never navigates",
            status: "ok",
            actions: [
              { method: "click", at: "2026-01-01T00:00:00.000Z", ms: 5 },
              { method: "click", at: "2026-01-01T00:00:00.010Z", ms: 5 },
            ],
          },
        }),
      );

      const { report } = await runTendJson(rootDir);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });

    it("reports a note right at the cutoff, and none just past it (the boundary is inclusive on the near side only)", async () => {
      await writeFile(
        path.join(rootDir, "at-cutoff.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step at the cutoff",
          stepRecord: {
            step: "a step at the cutoff",
            status: "ok",
            actions: [
              { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
              // Exactly 10,000ms after the navigation's own end.
              { method: "click", at: "2026-01-01T00:00:10.000Z", ms: 5 },
            ],
          },
        }),
      );
      await writeFile(
        path.join(rootDir, "past-cutoff.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step past the cutoff",
          stepRecord: {
            step: "a step past the cutoff",
            status: "ok",
            actions: [
              { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
              // 10,001ms after the navigation's own end.
              { method: "click", at: "2026-01-01T00:00:10.001Z", ms: 5 },
            ],
          },
        }),
      );

      const { report } = await runTendJson(rootDir);
      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes.map((n) => n.step)).toEqual(["a step at the cutoff"]);
    });

    it("excludes a read inside a ctx.poll window, but still reports one outside it on the same step record (fb5-stale-wait-poll task spec)", async () => {
      await writeFile(
        path.join(rootDir, "poll-covered.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step with one poll-covered read and one bare read",
          stepRecord: {
            step: "a step with one poll-covered read and one bare read",
            status: "ok",
            actions: [
              { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
              // Starts at 00:00:00.100Z, inside the poll window below
              // (00:00:00.080Z through 00:00:00.120Z) - excluded.
              { method: "expect", at: "2026-01-01T00:00:00.100Z", ms: 5 },
              { method: "goto", at: "2026-01-01T00:00:05.000Z", ms: 50 },
              // Starts at 00:00:05.100Z, nowhere near the poll window above
              // - reported, same as before this task shipped.
              { method: "click", at: "2026-01-01T00:00:05.100Z", ms: 5 },
            ],
            // `attempts: 1` on purpose (this task's spec, decision 2): a poll
            // that resolved on its first check is still a step written to
            // retry, so it excludes the read it covers exactly the same as
            // one that actually retried.
            polls: [{ at: "2026-01-01T00:00:00.080Z", attempts: 1, waited_ms: 40, outcome: "resolved" }],
          },
        }),
      );

      const { report } = await runTendJson(rootDir);
      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.message).toContain('"click"');
    });

    it("resolves a read landing exactly on either edge of a poll window toward excluding it (this task's spec, decision 3)", async () => {
      // One shared poll window: 00:00:01.000Z through 00:00:01.100Z
      // (waited_ms: 100).
      const poll = { at: "2026-01-01T00:00:01.000Z", attempts: 1, waited_ms: 100, outcome: "resolved" };

      await writeFile(
        path.join(rootDir, "poll-edge-start.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step whose read starts exactly on the poll window's near edge",
          stepRecord: {
            step: "a step whose read starts exactly on the poll window's near edge",
            status: "ok",
            actions: [
              { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
              // Starts exactly at the window's own start - included in the
              // window, so excluded.
              { method: "expect", at: "2026-01-01T00:00:01.000Z", ms: 5 },
            ],
            polls: [poll],
          },
        }),
      );
      await writeFile(
        path.join(rootDir, "poll-edge-end.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step whose read starts exactly on the poll window's far edge",
          stepRecord: {
            step: "a step whose read starts exactly on the poll window's far edge",
            status: "ok",
            actions: [
              { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
              // Starts exactly at the window's own end - included in the
              // window, so excluded.
              { method: "expect", at: "2026-01-01T00:00:01.100Z", ms: 5 },
            ],
            polls: [poll],
          },
        }),
      );
      await writeFile(
        path.join(rootDir, "poll-edge-just-before.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step whose read starts 1ms before the poll window",
          stepRecord: {
            step: "a step whose read starts 1ms before the poll window",
            status: "ok",
            actions: [
              { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
              // Starts 1ms before the window opens - outside it, so
              // reported, same as before this task shipped.
              { method: "expect", at: "2026-01-01T00:00:00.999Z", ms: 5 },
            ],
            polls: [poll],
          },
        }),
      );
      await writeFile(
        path.join(rootDir, "poll-edge-just-after.2026-01-01-0000000.md"),
        buildRecord({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step whose read starts 1ms after the poll window",
          stepRecord: {
            step: "a step whose read starts 1ms after the poll window",
            status: "ok",
            actions: [
              { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
              // Starts 1ms after the window closes - outside it, so
              // reported, same as before this task shipped.
              { method: "expect", at: "2026-01-01T00:00:01.101Z", ms: 5 },
            ],
            polls: [poll],
          },
        }),
      );

      const { report } = await runTendJson(rootDir);
      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes.map((n) => n.step).sort()).toEqual(
        [
          "a step whose read starts 1ms before the poll window",
          "a step whose read starts 1ms after the poll window",
        ].sort(),
      );
    });
  });
});
