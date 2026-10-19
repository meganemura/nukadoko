import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: run.json is untrusted input to all three formats of nuka
// report. Each field any renderer reads is checked at the boundary, so a
// run.json with any one field deleted or set to null is either refused
// with a coded refusal or rendered in full: never an unexpected-error, and
// never Markdown that prints `undefined` for a value it could not read.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Segment = string | number;

// Every path into the document, with each array visited through its first
// entry: one entry of a list is read the same way as every other.
function pathsOf(value: Json, prefix: readonly Segment[] = []): Segment[][] {
  if (Array.isArray(value)) return value.length === 0 ? [] : [[...prefix, 0], ...pathsOf(value[0]!, [...prefix, 0])];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [[...prefix, key], ...pathsOf(child, [...prefix, key])]);
}

function edited(document: Json, at: readonly Segment[], action: "delete" | "null"): Json {
  const copy = structuredClone(document) as Record<Segment, Json>;
  let parent = copy as Record<Segment, Json>;
  for (const segment of at.slice(0, -1)) parent = parent[segment] as Record<Segment, Json>;
  const last = at[at.length - 1]!;
  if (action === "null") parent[last] = null;
  else if (Array.isArray(parent)) parent.splice(last as number, 1);
  else delete parent[last];
  return copy;
}

describe("nuka report on a run.json with one field deleted or null", () => {
  let rootDir: string;
  let outside: string;
  let runId: string;
  let base: Json;

  beforeAll(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
    outside = mkdtempSync(path.join(os.tmpdir(), "nukadoko-fields-"));
    expect(
      await runCli(["run", "--no-check", "features/passing.feature", "features/failing.feature"], {
        rootDir,
        stdout: createCaptureSink(),
        stderr: createCaptureSink(),
      }),
    ).toBe(1);
    const document = latestRunJson(rootDir);
    runId = document.run_id as string;
    // Every optional field a renderer reads, present at least once, so
    // deleting or nulling it is part of what the property tries.
    const [first, failed] = [document.scenarios[0], document.scenarios.find((scenario: { status: string }) => scenario.status === "failed")];
    first.browser = { type: "chromium", version: "1.0.0" };
    first.probes = [{ line: 4, step: "a step", text: "a step", key: "n", recorded: 1, changed: 2, status: "not-measured", reason: "timeout", message: "m" }];
    const failedStep = failed.steps.find((step: { status: string }) => step.status === "failed");
    failedStep.used = [{ step: "producer", record: "steps/producer", result: { exitCode: 1, stderr: "boom" } }];
    failedStep.observed = { http_reads: 1, http_writes: 1, processes: [{ command: ["false"], cwd: ".", exit_code: 1, duration_ms: 1 }] };
    failed.hooks = [
      {
        type: "after_step",
        status: "passed",
        step_index: 0,
        name: "tidy",
        declared: { attachments: ["note.txt"], logs: ["a line"], labels: [{ name: "l", value: "v" }], links: [{ url: "https://example.com" }], parameters: [{ name: "p", value: "v" }] },
        trace: "trace.zip",
        named_traces: [{ as: "second", file: "second.zip" }],
      },
      { type: "after", status: "failed", name: "close", error: { message: "it broke", kind: "step_error" } },
    ];
    failed.evidence = { dir: `scenarios/${failed.scenario_record_id}`, screenshots: [{ file: "final.png", at: failed.finished_at }] };
    failed.teardown_errors = [{ fixture: "db", message: "gone" }];
    // What `--since` adds, so its fields are tried too.
    document.since = {
      ref: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      compared: ["features"],
      removed: [{ feature: "features/gone.feature", rule: null, scenario: "gone", lines: ["Given a step"] }],
      step_files: [{ file: "features/steps/a.ts", change: "changed" }],
    };
    first.criteria = { changed_since: "ambiguous", reason: "two of one name", lines: ["Given a step"], step_files: ["features/steps/a.ts"] };
    base = document as Json;
  }, 120_000);

  afterAll(async () => {
    await removeTempDir(rootDir);
    rmSync(outside, { recursive: true, force: true });
  });

  async function report(document: Json): Promise<{ format: string; exitCode: number; stdout: string; stderr: string }[]> {
    const copy = mkdtempSync(path.join(outside, "run-"));
    cpSync(path.join(rootDir, ".nukadoko", "runs", runId), copy, { recursive: true });
    writeFileSync(path.join(copy, "run.json"), JSON.stringify(document));
    const results = [];
    for (const format of ["markdown", "allure", "messages"]) {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const args = ["report", copy, "--format", format, ...(format === "allure" ? ["--out", path.join(copy, "allure")] : [])];
      const exitCode = await runCli(args, { rootDir: outside, stdout, stderr });
      results.push({ format, exitCode, stdout: stdout.text(), stderr: stderr.text() });
    }
    rmSync(copy, { recursive: true, force: true });
    return results;
  }

  it("renders the document as written, in all three formats", async () => {
    for (const result of await report(base)) {
      expect(result.stderr).not.toContain("unexpected-error");
      expect([0, 1]).toContain(result.exitCode);
    }
  });

  it("refuses with a code, or renders without undefined, for any one field deleted or null", () =>
    hegel.testAsync(
      async (tc) => {
        const at = tc.draw(gs.sampledFrom(pathsOf(base)));
        const action = tc.draw(gs.sampledFrom(["delete", "null"] as const));
        for (const result of await report(edited(base, at, action))) {
          expect(result.stderr, `${result.format} after ${action} ${at.join(".")}`).not.toContain("unexpected-error");
          if (result.exitCode === 2) {
            expect(result.stderr, `${result.format} after ${action} ${at.join(".")}`).toMatch(/^refused\trun-invalid\t/m);
          } else {
            expect([0, 1], `${result.format} after ${action} ${at.join(".")}`).toContain(result.exitCode);
          }
          if (result.format === "markdown") expect(result.stdout, `markdown after ${action} ${at.join(".")}`).not.toMatch(/\bundefined\b|\bNaN\b/);
        }
      },
      { testCases: 60, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ));
});
