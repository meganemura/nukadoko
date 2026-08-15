import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka accept` end to end against accept-project — a
// pure-step fixture (no browser, no HTTP server,
// same reasoning as tests/fixtures/run-project) whose only job is producing
// green/red/partial runs for `nuka accept` to react to. The fixture's own
// `.gitignore` (`.nukadoko/`, `features/*.md`) is not incidental: without
// it, the very act of `nuka run` writing its own state directory — or
// `nuka accept` writing its own record — would make the working tree
// "dirty" by refusal condition 3's own definition, before this file ever
// gets to exercise conditions 4-7. Real projects need the same entry
// (`nuka init` writes it automatically, docs/spec.md "The state
// directory"); this fixture just carries it from the start instead of
// relying on `nuka init` to have run first.

const execFileAsync = promisify(execFile);

async function commitAll(dir: string, message: string): Promise<string> {
  const git = (args: string[]) => execFileAsync("git", args, { cwd: dir, encoding: "utf8" });
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", message]);
  const { stdout } = await git(["rev-parse", "HEAD"]);
  return stdout.trim();
}

function jsonCodeBlocks(markdown: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const pattern = /```json\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push(JSON.parse(match[1]!));
  }
  return blocks;
}

function frontmatterText(markdown: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!match) throw new Error("no frontmatter block found in record");
  return match[1]!;
}

async function mdFilesIn(featuresDir: string): Promise<string[]> {
  const entries = await readdir(featuresDir);
  return entries.filter((name) => name.endsWith(".md")).sort();
}

describe("nuka accept: a green run", () => {
  let rootDir: string;
  let featuresDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
    featuresDir = path.join(rootDir, "features");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("writes a record with the feature's full text, frontmatter, and each step's step record with evidence stripped", async () => {
    const commit = await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(acceptExit).toBe(0);
    expect(stderr.text()).toBe("");

    const relativePath = stdout.text().trim();
    // The filename now bakes the condition in
    // (environment, then the browser segment — "no-browser" here, since
    // this fixture's own steps never destructure page/context).
    expect(relativePath).toMatch(
      new RegExp(`^features/greeting\\.\\d{4}-\\d{2}-\\d{2}-${commit.slice(0, 7)}\\.default\\.no-browser\\.md$`),
    );

    const content = await readFile(path.join(rootDir, relativePath), "utf8");

    // Full feature text, copied verbatim.
    const featureSource = await readFile(path.join(featuresDir, "greeting.feature"), "utf8");
    expect(content).toContain(featureSource.trimEnd());

    // Frontmatter values.
    const frontmatter = frontmatterText(content);
    expect(frontmatter).toContain("feature: features/greeting.feature");
    expect(frontmatter).toContain(`commit: ${commit}`);
    expect(frontmatter).toMatch(/run_id: run-\d{8}-\d{6}-[a-z0-9]{4}/);
    expect(frontmatter).toContain("environment: default");
    expect(frontmatter).toContain("name: greet a visitor");
    expect(frontmatter).toContain("line: 3");
    expect(frontmatter).toMatch(/scenario_id: scn-/);

    // Each step's own step record, with `evidence` stripped.
    const blocks = jsonCodeBlocks(content);
    expect(blocks).toHaveLength(2);
    for (const stepRecord of blocks) {
      expect("evidence" in stepRecord).toBe(false);
      expect(stepRecord.status).toBe("ok");
      expect(typeof stepRecord.record_id).toBe("string");
    }
    expect(blocks[0]!.args).toEqual({ name: "Ada" });

    // The record's own tail: none of
    // this fixture's steps make an HTTP call, so the section still exists
    // but reports zero mismatches rather than being omitted.
    expect(content).toContain("## Declared vs observed");
    expect(content).toContain("No step declared `mutates: false` and was measured making a write.");
  });

  it("writes ran_at/accepted_at as local-offset ISO strings whose date matches the filename (m4c-record-timestamps)", async () => {
    // No `TZ` fixture here on purpose (m4c-record-timestamps spec's own
    // testing note): rewriting `TZ` mid-process doesn't reliably change what
    // Node's Date/Intl internals already cached, so the only assertions
    // that mean the same thing on every machine/CI are format-shape and
    // cross-consistency with the filename, not a specific offset value.
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stdout = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(acceptExit).toBe(0);

    const relativePath = stdout.text().trim();
    const filenameDate = path.basename(relativePath).match(/\d{4}-\d{2}-\d{2}/)?.[0];
    expect(filenameDate).toBeDefined();

    const content = await readFile(path.join(rootDir, relativePath), "utf8");
    const frontmatter = frontmatterText(content);
    const localIsoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

    const ranAt = /ran_at: (\S+)/.exec(frontmatter)?.[1];
    const acceptedAt = /accepted_at: (\S+)/.exec(frontmatter)?.[1];
    expect(ranAt).toMatch(localIsoPattern);
    expect(acceptedAt).toMatch(localIsoPattern);

    // The invariant the whole task exists for: the filename's date and
    // `ran_at`'s date describe the same run, so they must be the same day
    // regardless of which timezone the machine running the test is in.
    expect(ranAt!.slice(0, 10)).toBe(filenameDate);
  });

  it("writes every scenario when a feature with multiple scenarios is all passed", async () => {
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/multi.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stdout = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/multi.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(acceptExit).toBe(0);

    const relativePath = stdout.text().trim();
    const content = await readFile(path.join(rootDir, relativePath), "utf8");

    const frontmatter = frontmatterText(content);
    expect(frontmatter).toContain("name: first visitor");
    expect(frontmatter).toContain("name: second visitor");
    expect(frontmatter).toContain("line: 3");
    expect(frontmatter).toContain("line: 6");

    expect(content).toContain("### first visitor (line 3)");
    expect(content).toContain("### second visitor (line 6)");
    expect(jsonCodeBlocks(content)).toHaveLength(2);
  });

  it("finds a run recorded under a differently-shaped but equivalent path", async () => {
    await initGitRepo(rootDir);

    // `nuka run` stores its argument verbatim, so this records the feature
    // as "./features/greeting.feature" — accept normalizes both sides
    // before comparing, or this run would be invisible to it.
    const runExit = await runCli(["run", "./features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    expect(acceptExit).toBe(0);
    expect(await mdFilesIn(featuresDir)).toHaveLength(1);
  });
});

describe("nuka accept: refusal conditions", () => {
  let rootDir: string;
  let featuresDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
    featuresDir = path.join(rootDir, "features");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("refuses on a dirty working tree and writes no record", async () => {
    await initGitRepo(rootDir);
    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    await writeFile(path.join(rootDir, "scratch.txt"), "never added or committed");

    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(acceptExit).toBe(1);
    expect(stderr.text()).toMatch(/dirty/i);
    // This fixture's own .gitignore
    // already excludes `.nukadoko/` (this file's own header comment), so
    // the only dirty path here is the unrelated scratch.txt above. The
    // state-directory sentence must not appear when nothing measured is
    // actually under it.
    expect(stderr.text()).not.toMatch(/state directory/i);
    expect(await mdFilesIn(featuresDir)).toEqual([]);
  });

  it("refuses on a dirty working tree caused by an untracked-in-.gitignore state directory, and names it", async () => {
    // Reproduces the loop this fixture exists for: a project whose
    // .gitignore never picked up the `.nukadoko/` entry `nuka init` writes
    // automatically, so nukadoko's own state directory shows up as
    // ordinary dirty content after every run instead of being invisible to
    // git, first as untracked files, then (once a user commits to clear
    // the first refusal) as tracked changes on every run after.
    await writeFile(path.join(rootDir, ".gitignore"), "features/*.md\n");
    await initGitRepo(rootDir);

    const firstRunExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(firstRunExit).toBe(0);

    await commitAll(rootDir, "track .nukadoko along with everything else");

    const secondRunExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(secondRunExit).toBe(0);

    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(acceptExit).toBe(1);
    expect(stderr.text()).toMatch(/dirty/i);
    expect(stderr.text()).toMatch(/state directory/i);
    expect(stderr.text()).toContain(".nukadoko/");
    expect(await mdFilesIn(featuresDir)).toEqual([]);
  });

  it("refuses once HEAD has moved since the run and writes no record", async () => {
    await initGitRepo(rootDir);
    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    await writeFile(path.join(rootDir, "unrelated-change.txt"), "a later commit");
    await commitAll(rootDir, "unrelated later commit");

    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(acceptExit).toBe(1);
    expect(stderr.text()).toMatch(/HEAD/);
    expect(await mdFilesIn(featuresDir)).toEqual([]);
  });

  it("refuses when only a red run of the feature exists, naming the run_id and the failed scenario's name and line, and writes no record", async () => {
    await initGitRepo(rootDir);
    const runStdout = createCaptureSink();
    const runExit = await runCli(["run", "features/failing.feature"], {
      rootDir,
      stdout: runStdout,
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(1);
    const runId = (JSON.parse(runStdout.text().trim()) as { run_id: string }).run_id;

    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/failing.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(acceptExit).toBe(1);
    expect(stderr.text()).toMatch(/not all green/);
    // A "red" refusal names what it read
    // to decide (docs/spec.md "Sign-off") — the run_id, not just "a run".
    expect(stderr.text()).toContain(`run_id ${runId}`);
    expect(stderr.text()).toContain("it fails partway through (line 3) failed");
    expect(await mdFilesIn(featuresDir)).toEqual([]);
  });

  it("refuses when only a partial (:line) run of the feature exists, naming the line it covered and the feature's total, and writes no record", async () => {
    await initGitRepo(rootDir);
    const runExit = await runCli(["run", "features/multi.feature:3"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/multi.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(acceptExit).toBe(1);
    expect(stderr.text()).toMatch(/partial/);
    // Names the line the most recent
    // partial run actually touched, out of the feature's own total.
    expect(stderr.text()).toContain("covered line 3 of 2 scenarios");
    expect(await mdFilesIn(featuresDir)).toEqual([]);
  });
});

describe("nuka accept: overwrite semantics", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("accepting twice on the same day at the same commit overwrites the same path", async () => {
    const commit = await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const firstStdout = createCaptureSink();
    const firstExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout: firstStdout,
      stderr: createCaptureSink(),
    });
    expect(firstExit).toBe(0);
    const relativePath = firstStdout.text().trim();
    const firstContent = await readFile(path.join(rootDir, relativePath), "utf8");

    // A short real delay, so the two records' own `accepted_at` timestamps
    // (millisecond ISO 8601) cannot coincide even on a very fast machine —
    // needed to prove the second write actually regenerated the content,
    // not merely that the first write survived untouched.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const secondStdout = createCaptureSink();
    const secondStderr = createCaptureSink();
    const secondExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout: secondStdout,
      stderr: secondStderr,
    });

    expect(secondExit).toBe(0);
    expect(secondStderr.text()).toBe("");
    expect(secondStdout.text().trim()).toBe(relativePath);
    expect(relativePath).toContain(commit.slice(0, 7));

    const secondContent = await readFile(path.join(rootDir, relativePath), "utf8");
    expect(secondContent).not.toBe(firstContent);
  });
});

describe("nuka accept: declared vs observed", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("does not refuse — and still writes a record — when a step's declared mutates: false disagrees with its own observed writes", async () => {
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    // The fixture's own "the visitor {name} is greeted" step already
    // declares `mutates: false` but never calls `ctx.request()`, so its
    // step record's own `observed.http_writes` is 0 — no mismatch to compare
    // against. Editing that one record.json directly is the only way to
    // produce a real declared/observed disagreement without adding network
    // I/O to a fixture whose whole point is running with no server at all.
    const stateDir = path.join(rootDir, ".nukadoko");
    const scenariosDir = path.join(stateDir, "records", "scenarios");
    const scenarioIds = await readdir(scenariosDir);
    let stepRecordPath: string | undefined;
    let stepText: string | undefined;
    for (const scenarioId of scenarioIds) {
      const record = JSON.parse(await readFile(path.join(scenariosDir, scenarioId, "record.json"), "utf8")) as {
        feature: string;
        steps: { text: string; record: string | null }[];
      };
      if (record.feature !== "features/greeting.feature") continue;
      const step = record.steps.find((s) => s.text.includes("greeted"));
      if (step?.record) {
        stepRecordPath = path.join(stateDir, "records", "steps", step.record, "record.json");
        stepText = step.text;
      }
    }
    if (!stepRecordPath || !stepText) throw new Error("could not locate the greeting step's own step record in the fixture run");

    const stepRecord = JSON.parse(await readFile(stepRecordPath, "utf8")) as { observed: { http_reads: number; http_writes: number } };
    stepRecord.observed = { http_reads: 0, http_writes: 2 };
    await writeFile(stepRecordPath, JSON.stringify(stepRecord));

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    // The mismatch is recorded as a fact, never a reason to refuse — none of
    // the seven rejection conditions read `mutates`/`observed` at all.
    expect(acceptExit).toBe(0);
    expect(stderr.text()).toBe("");

    const relativePath = stdout.text().trim();
    const content = await readFile(path.join(rootDir, relativePath), "utf8");
    expect(content).toContain("## Declared vs observed");
    expect(content).toContain(`declared mutates: false, observed 2 writes`);
    expect(content).toContain(stepText);
  });
});

describe("nuka accept: after a directory run", () => {
  let rootDir: string;
  let featuresDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
    featuresDir = path.join(rootDir, "features");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("accepts one feature out of several that ran in the same directory invocation", async () => {
    await initGitRepo(rootDir);

    // accept-project's own `features/` holds three files: greeting.feature
    // (green), multi.feature (green), failing.feature (red) — one directory
    // run touches all three, sharing one run_id, and the run's own exit
    // code is non-zero because of failing.feature. Neither fact is accept's
    // concern: this task's own required investigation found that `nuka
    // accept` never assumed "1 run = 1 feature" in the first place — it
    // filters `record.feature` down to the one feature named on the command
    // line before it ever looks at run_id grouping (src/accept/select-run.ts
    // groups only what cli/accept.ts already filtered) — so the real risk
    // was never accept.ts, it was `nuka run` mislabeling every record from a
    // directory run with the same single `relativePath` (see src/cli/run.ts,
    // `flatPickles`); this test is what would have caught that.
    const runStdout = createCaptureSink();
    const runExit = await runCli(["run", "features"], {
      rootDir,
      stdout: runStdout,
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(1);

    const records = runStdout
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { feature: string; run_id: string });
    expect(new Set(records.map((r) => r.feature))).toEqual(
      new Set(["features/failing.feature", "features/greeting.feature", "features/multi.feature"]),
    );
    expect(new Set(records.map((r) => r.run_id)).size).toBe(1);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(acceptExit).toBe(0);
    expect(stderr.text()).toBe("");
    expect(await mdFilesIn(featuresDir)).toEqual([
      expect.stringMatching(/^greeting\./),
    ]);

    const relativePath = stdout.text().trim();
    const content = await readFile(path.join(rootDir, relativePath), "utf8");
    expect(content).toContain("feature: features/greeting.feature");
    // Only greeting.feature's own scenario landed in the record — proof
    // this accept did not pull in a scenario from multi.feature or
    // failing.feature just because they shared the same run_id.
    expect(content).toContain("name: greet a visitor");
    expect(content).not.toContain("first visitor");
    expect(content).not.toContain("it fails partway through");
  });
});
