import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { constants } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  repoRoot,
  sourceNodeArgs,
  writeUrlProgram,
} from "./helpers/fixtures.js";

// Responsibility: a walk end to end, through the real CLI. `nuka run
// --step` runs as a child process with tests/fixtures/step-walk-project as
// its cwd, and pauses after each step with its process and its pages
// still open. `nuka step` answers it in this process, as a second command
// in another shell would: the two meet only through the walk's files.
//
// Covered: a walk through every step to a green end; an answer given
// twice, and a different answer to the same pause; an answer to a pause
// the walk is not at; a stop, and how the records name it; the --json
// rule for both commands; a failed step, after which nothing is left to
// stop; the views of a page at each pause; page traffic while paused,
// which is not the paused step's; the refusals that end a walk before its
// scenario runs; and a walk a signal ends or a SIGKILL leaves behind.
//
// No wait here has a deadline of its own beyond `nuka step`'s --timeout: a
// loaded runner can take tens of seconds to start the CLI. The test's own
// timeout is the bound that catches a hang.

const SPAWNED_TEST_TIMEOUT_MS = 240_000;
// Longer than the default 90 s, for the call that waits for the run to
// start: the start is what a loaded runner slows down.
const FIRST_WAIT = ["--timeout", "200"];

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = await isChromiumAvailable();

interface Walked {
  readonly child: ChildProcess;
  stdout(): string;
  stderr(): string;
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

const children: ChildProcess[] = [];

function collect(stream: NodeJS.ReadableStream | null): () => string {
  let text = "";
  stream?.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

// `nuka run` as its own process, as an agent's host runs it in the
// background, so that a signal or a SIGKILL reaches the run and not vitest.
function nukaRun(rootDir: string, args: readonly string[]): Walked {
  const child = spawn(process.execPath, [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), "run", ...args], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout, stderr, closed };
}

interface StepOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function nukaStep(rootDir: string, ...args: string[]): Promise<StepOutput> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const code = await runCli(["step", ...args], { rootDir, stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function nukaStepJson(rootDir: string, ...args: string[]): Promise<{ code: number; document: Record<string, any>; stderr: string }> {
  const output = await nukaStep(rootDir, ...args, "--json");
  return { code: output.code, document: JSON.parse(output.stdout) as Record<string, any>, stderr: output.stderr };
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
}

function walkState(rootDir: string): Record<string, any> {
  return readJson(path.join(rootDir, ".nukadoko", "walk.json"));
}

function runJson(rootDir: string, runDir: string): Record<string, any> {
  return readJson(path.join(rootDir, runDir, "run.json"));
}

function lineCount(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).length;
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stoppedBy(expected: NodeJS.Signals, code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === 128 + constants.signals[expected] || signal === expected;
}

describe("nuka run --step and nuka step", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("step-walk-project");
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    children.length = 0;
    await removeTempDir(rootDir);
  });

  it(
    "pauses after each step, goes on only when a pause is answered, and ends green",
    async () => {
      const run = nukaRun(rootDir, ["features/order.feature:3", "--step"]);

      const first = await nukaStep(rootDir, "wait", ...FIRST_WAIT);
      expect(first.code).toBe(0);
      const lines = first.stdout.split("\n");
      expect(lines[0]).toBe("walk 1 paused after step 1/3 (passed): a cart with 2 items");
      expect(lines[1]).toBe("  scenario: features/order.feature:3 an order is placed (default)");
      expect(lines[2]).toMatch(/^ {2}record: \.nukadoko\/runs\/[^/]+\/steps\/[^/]+\/record\.json$/);
      expect(lines[3]).toBe("  do: nuka step next 1 --walk 1   (or: nuka step stop 1 --walk 1)");
      expect(existsSync(path.join(rootDir, lines[2]!.replace("  record: ", "")))).toBe(true);

      // The run really waits: its process is alive and the walk stays at
      // pause 1 for as long as nobody answers.
      await settle(500);
      expect(run.child.exitCode).toBeNull();
      expect(walkState(rootDir)).toMatchObject({ state: "paused", number: 1, pause: { pause: 1, of: 3, remaining: 2 } });
      expect(run.stderr()).toContain("paused after step 1/3 (passed): a cart with 2 items\n  do: nuka step next 1 --walk 1   (or: nuka step stop 1 --walk 1)\n");

      // A wait at a pause reports that pause again, and answers nothing.
      expect((await nukaStep(rootDir, "wait")).stdout).toBe(first.stdout);

      const second = await nukaStep(rootDir, "next", "1", "--walk", "1");
      expect(second.code).toBe(0);
      expect(second.stdout).toMatch(/^walk 1 paused after step 2\/3 \(passed\): the order is placed\n/);

      // After the last step nothing is left to stop, so only next is offered.
      const third = await nukaStep(rootDir, "next", "2", "--walk", "1");
      expect(third.stdout).toMatch(/^walk 1 paused after step 3\/3 \(passed\): the cart holds 2 items\n/);
      expect(third.stdout).toContain("  do: nuka step next 3 --walk 1\n");
      expect(third.stdout).not.toContain("nuka step stop");

      const end = await nukaStep(rootDir, "next", "3", "--walk", "1");
      expect(end.code).toBe(0);
      const runDir = walkState(rootDir)["run_dir"] as string;
      expect(end.stdout).toBe(`walk 1 ended: the run finished, exit 0\n  run: ${runDir}/run.json\n`);
      expect((await run.closed).code).toBe(0);

      // A pause the walk never reached is no answer to its end.
      const never = await nukaStepJson(rootDir, "next", "1e2", "--walk", "1");
      expect(never.code).toBe(2);
      expect(never.document["findings"][0]).toMatchObject({ code: "pause-not-current", do: "nuka step wait --walk 1" });
      expect(never.document["findings"][0]["message"]).toBe("pause 100 is not a pause of walk 1, which ended after pause 3: the run finished, exit 0");

      const document = runJson(rootDir, runDir);
      expect(document["verdict"]).toBe("passed");
      expect(document["counts"]).toMatchObject({ passed: 1, failed: 0, stopped: 0 });
      expect(document["scenarios"][0]["status"]).toBe("passed");
      expect(document["walk"]["pauses"].map((pause: Record<string, unknown>) => [pause["pause"], pause["answer"]])).toEqual([
        [1, "next"],
        [2, "next"],
        [3, "next"],
      ]);
      expect(document["walk"]["pauses"].map((pause: Record<string, unknown>) => pause["step_record_id"])).toEqual(
        document["scenarios"][0]["steps"].map((step: Record<string, unknown>) => step["step_record_id"]),
      );
      const summary = await readFile(path.join(rootDir, runDir, "summary.md"), "utf8");
      expect(summary).toContain("Walked one step at a time (`nuka run --step`): 3 pauses");
      expect(summary).toContain("so this run is not the run a reviewer approves");
      // The lock goes with the walk, so the next walk can start.
      expect(existsSync(path.join(rootDir, ".nukadoko", "walk.lock"))).toBe(false);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "answers a pause once: the same answer again reports what followed it, and a different one is refused",
    async () => {
      const run = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      await nukaStep(rootDir, "wait", ...FIRST_WAIT);
      const answered = await nukaStep(rootDir, "next", "1", "--walk", "1");
      expect(answered.stdout).toMatch(/^walk 1 paused after step 2\/3/);
      const runDir = walkState(rootDir)["run_dir"] as string;
      const answerFile = path.join(rootDir, runDir, "answers", "1.json");
      const written = readFileSync(answerFile, "utf8");

      // A repeat after a lost output: pause 2 again, not pause 3, and the
      // answer file is not written again.
      const repeated = await nukaStep(rootDir, "next", "1", "--walk", "1");
      expect(repeated).toEqual(answered);
      expect(readFileSync(answerFile, "utf8")).toBe(written);
      expect(walkState(rootDir)).toMatchObject({ state: "paused", pause: { pause: 2 } });

      const contradicting = await nukaStep(rootDir, "stop", "1", "--walk", "1");
      expect(contradicting.code).toBe(2);
      expect(contradicting.stdout).toBe("");
      expect(contradicting.stderr).toContain("pause-answered");
      expect(contradicting.stderr).toContain("pause 1 was already answered next, so this stop changes nothing");
      expect(contradicting.stderr).toContain("do: nuka step wait --walk 1");
      expect(walkState(rootDir)).toMatchObject({ state: "paused", pause: { pause: 2 } });

      await nukaStep(rootDir, "stop", "2", "--walk", "1");
      await run.closed;
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "ties an answer to its walk: an answer for an earlier walk is refused and leaves the walk that replaced it alone",
    async () => {
      const first = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      await nukaStep(rootDir, "wait", ...FIRST_WAIT);
      expect((await nukaStep(rootDir, "stop", "1", "--walk", "1")).code).toBe(1);
      await first.closed;

      const second = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      const paused = await nukaStep(rootDir, "wait", ...FIRST_WAIT);
      expect(paused.stdout).toMatch(/^walk 2 paused after step 1\/3/);
      expect(paused.stdout).toContain("  do: nuka step next 1 --walk 2   (or: nuka step stop 1 --walk 2)\n");
      expect(second.stderr()).toContain("  do: nuka step next 1 --walk 2   (or: nuka step stop 1 --walk 2)\n");

      // The stop that ended walk 1, run again: it names walk 1, so walk 2
      // stays at its pause.
      const repeated = await nukaStep(rootDir, "stop", "1", "--walk", "1");
      expect(repeated.code).toBe(2);
      expect(repeated.stderr).toContain("walk-not-current");
      expect(repeated.stderr).toContain("this answer is for walk 1, and the walk in this project is walk 2, at pause 1");
      expect(repeated.stderr).toContain("do: nuka step wait --walk 2");
      // An answer that names no walk is refused before it reads the walk.
      const unnamed = await nukaStepJson(rootDir, "stop", "1");
      expect(unnamed.code).toBe(2);
      expect(unnamed.document["findings"][0]).toMatchObject({ severity: "refused" });
      expect(walkState(rootDir)).toMatchObject({ state: "paused", number: 2, pause: { pause: 1 } });
      expect(existsSync(path.join(rootDir, walkState(rootDir)["run_dir"] as string, "answers", "1.json"))).toBe(false);

      expect((await nukaStep(rootDir, "stop", "1", "--walk", "2")).code).toBe(1);
      await second.closed;
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "refuses an answer to a pause the walk is not at, and a pause that is not a whole number",
    async () => {
      const run = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      await nukaStep(rootDir, "wait", ...FIRST_WAIT);

      const ahead = await nukaStep(rootDir, "next", "2", "--walk", "1");
      expect(ahead.code).toBe(2);
      expect(ahead.stderr).toContain("pause-not-current");
      expect(ahead.stderr).toContain("pause 2 is not the pause the walk waits at: the walk is at pause 1");
      expect(ahead.stderr).toContain("do: nuka step wait --walk 1");

      for (const pause of ["0", "1.5", "one"]) {
        const invalid = await nukaStepJson(rootDir, "next", pause, "--walk", "1");
        expect(invalid.code).toBe(2);
        expect(invalid.document["findings"][0]).toMatchObject({ severity: "refused", code: "invalid-value" });
      }
      const badWalk = await nukaStepJson(rootDir, "next", "1", "--walk", "0");
      expect(badWalk.code).toBe(2);
      expect(badWalk.document["findings"][0]).toMatchObject({ severity: "refused", code: "invalid-value" });
      // Nothing above moved the walk.
      expect(walkState(rootDir)).toMatchObject({ state: "paused", pause: { pause: 1 } });
      expect(existsSync(path.join(rootDir, walkState(rootDir)["run_dir"] as string, "answers", "2.json"))).toBe(false);

      await nukaStep(rootDir, "stop", "1", "--walk", "1");
      await run.closed;
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "stops a walk at a pause: the steps after it do not run, and every record says stopped, not failed",
    async () => {
      const run = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      await nukaStep(rootDir, "wait", ...FIRST_WAIT);
      await nukaStep(rootDir, "next", "1", "--walk", "1");

      const stopped = await nukaStep(rootDir, "stop", "2", "--walk", "1");
      expect(stopped.code).toBe(1);
      expect(stopped.stdout).toMatch(/^walk 1 ended: stopped after step 2 \(line 5\), exit 1\n {2}run: /);
      expect(stopped.stderr).toContain("walk-stopped");
      expect((await run.closed).code).toBe(1);

      const runDir = walkState(rootDir)["run_dir"] as string;
      const document = runJson(rootDir, runDir);
      const scenario = document["scenarios"][0];
      expect(scenario["status"]).toBe("stopped");
      expect(scenario["stopped"]).toEqual({ after_step: 2, line: 5 });
      expect(scenario["steps"].map((step: Record<string, unknown>) => step["status"])).toEqual(["passed", "passed", "skipped"]);
      expect(document["counts"]).toMatchObject({ passed: 0, failed: 0, stopped: 1 });
      expect(document["table"]["rows"][0]["cells"][0]).toMatchObject({ outcome: "stopped", line: 5 });
      expect(document["findings"].map((finding: Record<string, unknown>) => finding["code"])).toContain("walk-stopped");
      expect(document["findings"].map((finding: Record<string, unknown>) => finding["code"])).not.toContain("scenario-failed");
      expect(document["walk"]["pauses"].map((pause: Record<string, unknown>) => pause["answer"])).toEqual(["next", "stop"]);
      expect(run.stderr()).toContain("1 scenario: 0 passed, 0 failed, 1 stopped");
      const summary = await readFile(path.join(rootDir, runDir, "summary.md"), "utf8");
      expect(summary).toContain("## Rerun a stopped scenario");

      // The stop that ended the walk, again: the same end. A next to that
      // pause now contradicts the stop, and the wait it offers names the
      // walk, so it reports this end rather than waiting for the next walk.
      expect(await nukaStep(rootDir, "stop", "2", "--walk", "1")).toEqual(stopped);
      const late = await nukaStep(rootDir, "next", "2", "--walk", "1");
      expect(late.code).toBe(2);
      expect(late.stderr).toContain("pause-answered");
      expect(late.stderr).toContain("pause 2 was already answered stop, and walk 1 ended: stopped after step 2 (line 5), exit 1, so this next changes nothing");
      expect(late.stderr).toContain("do: nuka step wait --walk 1");
      expect((await nukaStep(rootDir, "wait", "--walk", "1")).stdout).toBe(stopped.stdout);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "keeps --json for one document on stdout: nothing from the run on stderr, and nuka step's envelope on its stdout alone",
    async () => {
      const run = nukaRun(rootDir, ["features/order.feature:3", "--step", "--json"]);

      const paused = await nukaStepJson(rootDir, "wait", ...FIRST_WAIT);
      expect(paused.code).toBe(0);
      expect(paused.stderr).toBe("");
      expect(paused.document).toMatchObject({
        command: "step wait",
        verdict: "passed",
        findings: [],
        walk: "paused",
        scenario: { feature: "features/order.feature", line: 3, name: "an order is placed", environment: "default" },
        pause: { pause: 1, of: 3, line: 4, text: "a cart with 2 items", step: "a-cart", status: "passed", remaining: 2, views: [] },
        world: null,
        do: { next: "nuka step next 1 --walk 1", stop: "nuka step stop 1 --walk 1" },
      });
      expect(paused.document["run_dir"]).toMatch(/^\.nukadoko\/runs\//);
      expect(paused.document["pause"]["record"]).toMatch(/^steps\//);

      const ended = await nukaStepJson(rootDir, "stop", "1", "--walk", "1");
      expect(ended.code).toBe(1);
      expect(ended.stderr).toBe("");
      expect(ended.document).toMatchObject({ command: "step stop", verdict: "failed", walk: "ended", end: { how: "finished", exit_code: 1, stopped: { after_step: 1, line: 4 } } });

      expect((await run.closed).code).toBe(1);
      expect(run.stderr()).toBe("");
      const document = JSON.parse(run.stdout()) as Record<string, any>;
      expect(document["command"]).toBe("run");
      expect(document["scenarios"][0]["status"]).toBe("stopped");
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "pauses after a failed step with nothing left to stop, and a stop there leaves the scenario failed",
    async () => {
      const run = nukaRun(rootDir, ["features/order.feature:8", "--step"]);
      await nukaStep(rootDir, "wait", ...FIRST_WAIT);

      const failed = await nukaStep(rootDir, "next", "1", "--walk", "1");
      expect(failed.code).toBe(0);
      expect(failed.stdout).toMatch(/^walk 1 paused after step 2\/3 \(failed\): the order is placed\n/);
      expect(failed.stdout).toContain("  error: the cart is empty\n");
      expect(failed.stdout).toContain("  do: nuka step next 2 --walk 1\n");
      expect(failed.stdout).not.toContain("nuka step stop");
      expect(walkState(rootDir)).toMatchObject({ pause: { status: "failed", remaining: 0, error: { message: "the cart is empty" } } });

      const end = await nukaStep(rootDir, "stop", "2", "--walk", "1");
      expect(end.code).toBe(1);
      expect(end.stdout).toMatch(/^walk 1 ended: the run finished, exit 1\n/);
      expect((await run.closed).code).toBe(1);

      const document = runJson(rootDir, walkState(rootDir)["run_dir"] as string);
      expect(document["scenarios"][0]["status"]).toBe("failed");
      expect(document["scenarios"][0]["stopped"]).toBeUndefined();
      expect(document["counts"]).toMatchObject({ failed: 1, stopped: 0 });
      // The answer is kept as given, though it stopped nothing.
      expect(document["walk"]["pauses"].map((pause: Record<string, unknown>) => pause["answer"])).toEqual(["next", "stop"]);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it.skipIf(!chromiumAvailable)(
    "shows a view of each open page at a pause, taken after the step, and leaves the page as the step left it",
    async () => {
      const run = nukaRun(rootDir, ["features/page.feature:3", "--step"]);

      const first = await nukaStep(rootDir, "wait", ...FIRST_WAIT);
      const runDir = walkState(rootDir)["run_dir"] as string;
      expect(first.stdout).toContain(
        `  view: page 1 about:blank "Cart": ${runDir}/pauses/1/page.png ${runDir}/pauses/1/page.aria.yml\n`,
      );
      expect(existsSync(path.join(rootDir, runDir, "pauses", "1", "page.png"))).toBe(true);
      expect(readFileSync(path.join(rootDir, runDir, "pauses", "1", "page.aria.yml"), "utf8")).toContain('heading "Cart"');

      await nukaStep(rootDir, "next", "1", "--walk", "1");
      const focused = readFileSync(path.join(rootDir, runDir, "pauses", "2", "page.aria.yml"), "utf8");
      expect(focused).toMatch(/textbox "Coupon" \[active\]/);

      // The third step reads the focus the second step left; a view that
      // moved it would fail the scenario here.
      const end = await nukaStep(rootDir, "next", "2", "--walk", "1");
      expect(end.stdout).toMatch(/^walk 1 paused after step 3\/3 \(passed\)/);
      expect((await nukaStep(rootDir, "next", "3", "--walk", "1")).code).toBe(0);
      expect((await run.closed).code).toBe(0);

      const document = runJson(rootDir, runDir);
      expect(document["walk"]["pauses"][1]["views"]).toEqual([
        { as: null, page: 1, url: "about:blank", title: "Cart", screenshot: "pauses/2/page.png", aria: "pauses/2/page.aria.yml" },
      ]);
      // The views are the pause's, never inside the step record.
      const stepDir = path.join(rootDir, runDir, "steps", document["walk"]["pauses"][1]["step_record_id"] as string);
      expect(existsSync(path.join(stepDir, "page.png"))).toBe(false);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  describe.skipIf(!chromiumAvailable)("page traffic while paused", () => {
    let server: Server;
    let ticks = 0;

    beforeEach(async () => {
      ticks = 0;
      server = createServer((req, res) => {
        if (req.url === "/poll") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end('<title>Poll</title><label>Coupon <input id=coupon></label><script>setInterval(() => fetch("/tick"), 50)</script>');
          return;
        }
        if (req.url === "/tick") ticks += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      await writeUrlProgram(rootDir, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it(
      "goes beside the pause, not into the record of the step it paused after",
      async () => {
        const run = nukaRun(rootDir, ["features/poll.feature:3", "--step"]);
        const first = await nukaStep(rootDir, "wait", ...FIRST_WAIT);
        expect(first.stdout).toContain("  world: http://127.0.0.1:");
        const state = walkState(rootDir);
        const runDir = state["run_dir"] as string;
        const stepHttp = path.join(rootDir, runDir, state["pause"]["record"] as string, "http.jsonl");
        const heldHttp = path.join(rootDir, runDir, "pauses", "1", "http.jsonl");
        const atPause = lineCount(stepHttp);
        const heldAtPause = lineCount(heldHttp);

        // The server counts what the page sends, so this wait ends whether
        // or not the run holds the traffic, and the checks below say where
        // it went. The pause is long enough for the log to catch up.
        const ticksAtPause = ticks;
        while (ticks < ticksAtPause + 5) await settle(50);
        await settle(300);
        expect(lineCount(stepHttp)).toBe(atPause);
        expect(lineCount(heldHttp)).toBeGreaterThan(heldAtPause);
        expect(readFileSync(heldHttp, "utf8")).toContain("/tick");

        await nukaStep(rootDir, "next", "1", "--walk", "1");
        await nukaStep(rootDir, "next", "2", "--walk", "1");
        expect((await nukaStep(rootDir, "next", "3", "--walk", "1")).code).toBe(0);
        expect((await run.closed).code).toBe(0);
        const document = runJson(rootDir, runDir);
        expect(document["walk"]["pauses"][0]["http"]).toBe("pauses/1/http.jsonl");
      },
      SPAWNED_TEST_TIMEOUT_MS,
    );
  });

  it(
    "refuses a walk of more than one scenario, and records that walk as ended before its scenario ran",
    async () => {
      const run = nukaRun(rootDir, ["features/order.feature", "--step"]);
      expect((await run.closed).code).toBe(2);
      expect(run.stderr()).toContain("step-needs-one-scenario");
      expect(run.stderr()).toContain("the targets select 2 scenarios");
      expect(walkState(rootDir)).toMatchObject({ state: "ended", number: 1, end: { how: "not-run", exit_code: 2 } });

      // The walk never paused, so no pause of it can be answered.
      const answer = await nukaStep(rootDir, "next", "1", "--walk", "1");
      expect(answer.code).toBe(2);
      expect(answer.stderr).toContain("pause-not-current");
      expect(answer.stderr).toContain("pause 1 is not a pause of walk 1, which ended before its scenario ran, exit 2");
      expect(answer.stderr).toContain("do: nuka step wait --walk 1");
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "reports a walk that ended before the wait started, once, and then waits for the next walk",
    async () => {
      const run = nukaRun(rootDir, ["features/order.feature", "--step"]);
      expect((await run.closed).code).toBe(2);

      const ended = await nukaStep(rootDir, "wait", "--timeout", "5");
      expect(ended.code).toBe(1);
      expect(ended.stdout).toBe("walk 1 ended before its scenario ran, exit 2\n");
      expect(ended.stderr).toContain("step-needs-one-scenario");

      // That end was reported, so a wait now waits for the next walk, and
      // names the last walk and how it ended when none starts.
      const next = await nukaStepJson(rootDir, "wait", "--timeout", "0");
      expect(next.code).toBe(2);
      expect(next.document["findings"][0]).toMatchObject({ code: "walk-not-found" });
      expect(next.document["findings"][0]["message"]).toContain("the last walk, walk 1, ended before its scenario ran, exit 2");
      expect(next.document).toMatchObject({ walk: "none", last: { number: 1, state: "ended" } });

      // A wait that names the walk reports it however often it was reported.
      expect(await nukaStep(rootDir, "wait", "--walk", "1")).toEqual(ended);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "reports a walk whose run has not begun its scenario as starting, not as running a step",
    async () => {
      // A program that takes seconds to listen keeps the walk starting.
      await writeFile(
        path.join(rootDir, "slow-server.mjs"),
        'import { createServer } from "node:http";\nsetTimeout(() => createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1"), 4000);\n',
      );
      await writeFile(
        path.join(rootDir, "nukadoko.program.ts"),
        'import { defineProgram } from "./nukadoko-shim.js";\nexport default defineProgram({ serve: { command: "node slow-server.mjs", ready: "/" }, env: { PORT: "{port}" } });\n',
      );
      const run = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      while (!existsSync(path.join(rootDir, ".nukadoko", "walk.json"))) await settle(50);

      const starting = await nukaStepJson(rootDir, "wait", "--timeout", "1");
      expect(starting.code).toBe(0);
      expect(starting.document).toMatchObject({ walk: "starting", do: "nuka step wait --walk 1" });
      expect(starting.document["after"]).toBeUndefined();
      const text = await nukaStep(rootDir, "wait", "--timeout", "0");
      expect(text.stdout).toBe("walk 1 is starting: its run has not begun the scenario yet\n  do: nuka step wait --walk 1\n");

      expect((await nukaStep(rootDir, "wait", ...FIRST_WAIT)).stdout).toMatch(/^walk 1 paused after step 1\/3/);
      await nukaStep(rootDir, "stop", "1", "--walk", "1");
      await run.closed;
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a second walk while one is live in the project",
    async () => {
      const first = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      await nukaStep(rootDir, "wait", ...FIRST_WAIT);

      const second = nukaRun(rootDir, ["features/order.feature:8", "--step", "--json"]);
      expect((await second.closed).code).toBe(2);
      const refusal = JSON.parse(second.stdout()) as Record<string, any>;
      expect(refusal["findings"][0]).toMatchObject({ severity: "refused", code: "walk-in-progress", do: "nuka step wait" });
      expect(walkState(rootDir)).toMatchObject({ state: "paused", number: 1 });

      await nukaStep(rootDir, "stop", "1", "--walk", "1");
      await first.closed;
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform !== "win32")(
    "records a walk a signal ended as interrupted, and releases it",
    async () => {
      const run = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      await nukaStep(rootDir, "wait", ...FIRST_WAIT);
      run.child.kill("SIGTERM");
      const closed = await run.closed;
      expect(stoppedBy("SIGTERM", closed.code, closed.signal)).toBe(true);

      // No nuka step saw that end yet, so a wait reports it.
      const wait = await nukaStep(rootDir, "wait", "--timeout", "5");
      expect(wait.code).toBe(1);
      expect(wait.stdout).toBe("walk 1 ended: interrupted by SIGTERM, exit 143\n");

      const answer = await nukaStep(rootDir, "next", "1", "--walk", "1");
      expect(answer.code).toBe(1);
      expect(answer.stdout).toBe("walk 1 ended: interrupted by SIGTERM, exit 143\n");
      expect(existsSync(path.join(rootDir, ".nukadoko", "walk.lock"))).toBe(false);
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform !== "win32")(
    "reports a walk whose run was killed as gone, and lets the next walk take its place",
    async () => {
      const killed = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      await nukaStep(rootDir, "wait", ...FIRST_WAIT);
      killed.child.kill("SIGKILL");
      await killed.closed;

      const wait = await nukaStep(rootDir, "wait", "--timeout", "5");
      expect(wait.code).toBe(1);
      expect(wait.stdout).toMatch(/^walk 1 is gone: its nuka run --step process \(pid \d+\) ended without recording how\n$/);

      const answer = await nukaStep(rootDir, "next", "1", "--walk", "1");
      expect(answer.code).toBe(1);
      expect(answer.stdout).toMatch(/^walk 1 is gone: its nuka run --step process \(pid \d+\) ended without recording how\n$/);
      expect(answer.stderr).toContain("walk-gone");
      expect(answer.stderr).toContain("do: nuka run features/order.feature:3 --step");

      const next = nukaRun(rootDir, ["features/order.feature:3", "--step"]);
      const paused = await nukaStep(rootDir, "wait", ...FIRST_WAIT);
      expect(paused.stdout).toMatch(/^walk 2 paused after step 1\/3/);
      await nukaStep(rootDir, "stop", "1", "--walk", "2");
      await next.closed;
    },
    SPAWNED_TEST_TIMEOUT_MS,
  );
});
