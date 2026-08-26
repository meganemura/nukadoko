import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka tend`'s `post-navigation-read` note end to end. One
// test runs a real chromium navigation
// followed immediately by a real `expect()` call (tests/fixtures/
// trace-actions-project's own `wait-for-late-element` step, already proven
// by tests/trace-actions-expect.test.ts to produce a real trace with both
// calls) through `nuka run`, so the note's own gap math runs against an
// actual measured step record at least once, rather than guessed - and a
// second confirms the note disappears once that live step record is
// removed, sign-off or not. The rest hand-craft one step record's own
// `record.json` directly under `.nukadoko/records/steps/` (this finding's
// own input, and a hand-crafted acceptance-record-shaped markdown file
// proves that path is never read as one): these exist only to pin down
// this finding's own boundary math (a gap far enough apart, a negative gap,
// a step record with no `actions` at all, a step with no navigation call),
// which does not need a second browser launch to prove.

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

/** Writes one step record directly under `<rootDir>/.nukadoko/records/
 * steps/<id>/record.json`, the on-disk shape `nuka do`/`nuka run` produce
 * and src/tend/post-navigation-read.ts now reads (that finding's input,
 * once a committed acceptance record). `stepRecord` is passed straight
 * through to `JSON.stringify`, so its own `actions`/`polls` (or lack of
 * either) is exactly what that finding sees. Returns the file's own path,
 * rootDir-relative - the same shape `TendIssue.file` reports. */
async function writeStepRecordFile(rootDir: string, id: string, stepRecord: Record<string, unknown>): Promise<string> {
  const dir = path.join(rootDir, ".nukadoko", "records", "steps", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "record.json"), JSON.stringify(stepRecord, null, 2));
  return path.join(".nukadoko", "records", "steps", id, "record.json");
}

const COMMIT = "0".repeat(40);

/** A hand-assembled acceptance record, the shape a committed record has
 * always had: valid frontmatter (the four required keys), a "## The
 * scenario as it ran" fenced feature, and one `#### <step>` fenced JSON
 * step record whose `actions` would trigger this finding if it were still
 * read from here. Used only to prove the negative: this finding's own
 * input moved to `.nukadoko/records/steps/`, so no markdown file anywhere
 * in the project is opened by it, however record-shaped that file's own
 * text is. */
function buildLegacyAcceptedRecordText(options: { featurePath: string; stepText: string; stepRecord: Record<string, unknown> }): string {
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
    "    scenario_record_id: scn-synthetic",
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

describe("nuka tend: post-navigation-read", () => {
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

      // Never accepted - this note's own input is the live step record
      // `nuka run` just wrote, not something `nuka accept` has to freeze
      // first.
      const stepIds = await readdir(path.join(rootDir, ".nukadoko", "records", "steps"));
      expect(stepIds).toHaveLength(1);
      const recordPath = path.join(".nukadoko", "records", "steps", stepIds[0]!, "record.json");

      const { report, exitCode } = await runTendJson(rootDir);
      // A note never sets tend's own exit code.
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
      // Not a verdict, the same
      // wording fixture-touches-app.ts's own note already uses.
      expect(notes[0]!.message).toContain("Not a judgment");
    });

    it("stops reporting once the live step record is gone, whether or not the scenario has since been signed off", async () => {
      const runExit = await runCli(["run", "features/wait-for-late-element.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(runExit).toBe(0);

      const acceptExit = await runCli(["accept", "features/wait-for-late-element.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      });
      expect(acceptExit).toBe(0);

      // Remove every live step record. Whatever the committed acceptance
      // record embeds is a separate question from what this finding reads
      // (src/accept/render-record.ts decides the former) - this test only
      // needs there to be no live step record left for it to read.
      await rm(path.join(rootDir, ".nukadoko", "records", "steps"), { recursive: true, force: true });

      const { report } = await runTendJson(rootDir);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });
  });

  describe("a hand-crafted step record", () => {
    let rootDir: string;

    beforeEach(async () => {
      rootDir = await copyFixtureToTempDir("tend-clean-project");
    });

    afterEach(async () => {
      await removeTempDir(rootDir);
    });

    it("reports nothing, and does not throw, for a project with no step records directory at all", async () => {
      const { report, exitCode } = await runTendJson(rootDir);
      expect(exitCode).toBe(0);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });

    it("does not read a navigation-then-call pair embedded in a committed acceptance record, only in a live step record", async () => {
      await writeFile(
        path.join(rootDir, "legacy-accepted.2026-01-01-0000000.md"),
        buildLegacyAcceptedRecordText({
          featurePath: "features/does-not-exist.feature",
          stepText: "a step whose committed record still carries actions",
          stepRecord: {
            step: "a step whose committed record still carries actions",
            status: "ok",
            actions: [
              { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
              { method: "click", at: "2026-01-01T00:00:00.100Z", ms: 5 },
            ],
          },
        }),
      );

      const { report } = await runTendJson(rootDir);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });

    it("reports nothing when the next call is far enough from the navigation's own end", async () => {
      await writeStepRecordFile(rootDir, "far-apart", {
        step: "a step with a wide gap",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
          // 2026-01-01T00:00:20.050Z minus (00:00.000Z + 50ms) = 20000ms,
          // twice this finding's own 10s cutoff.
          { method: "click", at: "2026-01-01T00:00:20.050Z", ms: 5 },
        ],
      });

      const { report } = await runTendJson(rootDir);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });

    it("reports nothing when the gap is negative, an overlapping trace entry rather than a delayed read", async () => {
      await writeStepRecordFile(rootDir, "negative-gap", {
        step: "a step whose next call appears to start before the navigation ended",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.100Z", ms: 50 },
          // Starts at 00:00:00.120Z, before the navigation above is
          // recorded as finished (00:00:00.150Z).
          { method: "click", at: "2026-01-01T00:00:00.120Z", ms: 5 },
        ],
      });

      const { report } = await runTendJson(rootDir);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });

    it("reports nothing, and does not throw, for a step record with no actions field at all", async () => {
      await writeStepRecordFile(rootDir, "no-actions", {
        step: "a step accepted before actions existed",
        status: "ok",
      });

      const { report } = await runTendJson(rootDir);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });

    it("reports nothing for a step whose actions never include a navigation call", async () => {
      await writeStepRecordFile(rootDir, "no-navigation", {
        step: "a step that never navigates",
        status: "ok",
        actions: [
          { method: "click", at: "2026-01-01T00:00:00.000Z", ms: 5 },
          { method: "click", at: "2026-01-01T00:00:00.010Z", ms: 5 },
        ],
      });

      const { report } = await runTendJson(rootDir);
      expect(report.notes.filter((n) => n.code === "post-navigation-read")).toEqual([]);
    });

    it("reports a note right at the cutoff, and none just past it (the boundary is inclusive on the near side only)", async () => {
      await writeStepRecordFile(rootDir, "at-cutoff", {
        step: "a step at the cutoff",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
          // Exactly 10,000ms after the navigation's own end.
          { method: "click", at: "2026-01-01T00:00:10.000Z", ms: 5 },
        ],
      });
      await writeStepRecordFile(rootDir, "past-cutoff", {
        step: "a step past the cutoff",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
          // 10,001ms after the navigation's own end.
          { method: "click", at: "2026-01-01T00:00:10.001Z", ms: 5 },
        ],
      });

      const { report } = await runTendJson(rootDir);
      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes.map((n) => n.step)).toEqual(["a step at the cutoff"]);
    });

    it("names ctx.poll in the note, the one shape that makes the note stop being true", async () => {
      // Without this, a reader who wants to act reaches for a direct
      // browser wait instead. That wait is itself a call right after the
      // navigation, so the note comes back naming it, and reads as though
      // no way of writing the step can ever silence it.
      await writeStepRecordFile(rootDir, "bare-read", {
        step: "a step that reads right after navigating",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
          { method: "click", at: "2026-01-01T00:00:00.060Z", ms: 5 },
        ],
      });

      const { report } = await runTendJson(rootDir);
      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.message).toContain("ctx.poll");
    });

    it("reports a note for a kind: \"do\" step record, even though it was never accepted, and names its record.json", async () => {
      const recordPath = await writeStepRecordFile(rootDir, "do-kind", {
        step: "a step run only through nuka do",
        status: "ok",
        kind: "do",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
          { method: "click", at: "2026-01-01T00:00:00.100Z", ms: 5 },
        ],
      });

      const { report } = await runTendJson(rootDir);
      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.step).toBe("a step run only through nuka do");
      expect(notes[0]!.file).toBe(recordPath);
    });

    it("excludes a read inside a ctx.poll window, but still reports one outside it on the same step record", async () => {
      await writeStepRecordFile(rootDir, "poll-covered", {
        step: "a step with one poll-covered read and one bare read",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 50 },
          // Starts at 00:00:00.100Z, inside the poll window below
          // (00:00:00.080Z through 00:00:00.120Z) - excluded.
          { method: "expect", at: "2026-01-01T00:00:00.100Z", ms: 5 },
          { method: "goto", at: "2026-01-01T00:00:05.000Z", ms: 50 },
          // Starts at 00:00:05.100Z, nowhere near the poll window above -
          // reported.
          { method: "click", at: "2026-01-01T00:00:05.100Z", ms: 5 },
        ],
        // `attempts: 1` on purpose: a poll
        // that resolved on its first check is still a step written to
        // retry, so it excludes the read it covers exactly the same as
        // one that actually retried.
        polls: [{ at: "2026-01-01T00:00:00.080Z", attempts: 1, waited_ms: 40, outcome: "resolved" }],
      });

      const { report } = await runTendJson(rootDir);
      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.message).toContain('"click"');
    });

    it("resolves a read landing exactly on either edge of a poll window toward excluding it", async () => {
      // One shared poll window: 00:00:01.000Z through 00:00:01.100Z
      // (waited_ms: 100).
      const poll = { at: "2026-01-01T00:00:01.000Z", attempts: 1, waited_ms: 100, outcome: "resolved" };

      await writeStepRecordFile(rootDir, "poll-edge-start", {
        step: "a step whose read starts exactly on the poll window's near edge",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
          // Starts exactly at the window's own start - included in the
          // window, so excluded.
          { method: "expect", at: "2026-01-01T00:00:01.000Z", ms: 5 },
        ],
        polls: [poll],
      });
      await writeStepRecordFile(rootDir, "poll-edge-end", {
        step: "a step whose read starts exactly on the poll window's far edge",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
          // Starts exactly at the window's own end - included in the
          // window, so excluded.
          { method: "expect", at: "2026-01-01T00:00:01.100Z", ms: 5 },
        ],
        polls: [poll],
      });
      await writeStepRecordFile(rootDir, "poll-edge-just-before", {
        step: "a step whose read starts 1ms before the poll window",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
          // Starts 1ms before the window opens - outside it, so reported.
          { method: "expect", at: "2026-01-01T00:00:00.999Z", ms: 5 },
        ],
        polls: [poll],
      });
      await writeStepRecordFile(rootDir, "poll-edge-just-after", {
        step: "a step whose read starts 1ms after the poll window",
        status: "ok",
        actions: [
          { method: "goto", at: "2026-01-01T00:00:00.000Z", ms: 0 },
          // Starts 1ms after the window closes - outside it, so reported.
          { method: "expect", at: "2026-01-01T00:00:01.101Z", ms: 5 },
        ],
        polls: [poll],
      });

      const { report } = await runTendJson(rootDir);
      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes.map((n) => n.step).sort()).toEqual(
        [
          "a step whose read starts 1ms before the poll window",
          "a step whose read starts 1ms after the poll window",
        ].sort(),
      );
    });

    it("merges the same (step, navigation method, next method) across many step records into one note", async () => {
      // Mirrors a Background step that runs in every scenario: the same
      // step name, the same navigation-then-call shape, once per step
      // record. Three step records, three different gaps (two of them
      // equal), so the merged note's own range can be checked against both
      // ends.
      const gapsMs = [100, 150, 100];
      for (const [index, gapMs] of gapsMs.entries()) {
        const navigationEndsAt = new Date(0).toISOString();
        const nextStartsAt = new Date(gapMs).toISOString();
        await writeStepRecordFile(rootDir, `background-${index}`, {
          step: "open-todo-app",
          status: "ok",
          actions: [
            { method: "goto", at: navigationEndsAt, ms: 0 },
            { method: "waitForSelector", at: nextStartsAt, ms: 5 },
          ],
        });
      }

      const { report } = await runTendJson(rootDir);
      const notes = report.notes.filter((n) => n.code === "post-navigation-read");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.step).toBe("open-todo-app");
      // How many step records this happened in.
      expect(notes[0]!.message).toContain("3");
      // The gap range: the smallest and the largest of the three gaps.
      expect(notes[0]!.message).toContain("100");
      expect(notes[0]!.message).toContain("150");
      // "Not a judgment" appears exactly once, not once per merged record.
      expect(notes[0]!.message.match(/Not a judgment/g)).toHaveLength(1);
    });
  });
});
