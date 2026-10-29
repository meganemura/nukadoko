import { existsSync, readFileSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir, writeUrlProgram } from "./helpers/fixtures.js";

// Responsibility: execution events end to end against
// tests/fixtures/events-project, whose server and the job worker it starts
// both append one line per operation to the file `{events}` names
// (docs/execution-events.md). Each step record holds the lines whose
// `trace` carries its trace id, redacted, with what of its work is still
// open; a line that arrives after the record goes to the step's late file;
// the world's redacted copy and its counts land in the world's directory
// and run.json; the file itself lives outside the run directory and is
// gone once the world stops. A world at a URL has no such file, and
// refuses `{events}` by name.

async function cli(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(args, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

interface EventsFacts {
  readonly trace_id: string;
  readonly lines: number;
  readonly file: string | null;
  readonly kinds: Record<string, number>;
  readonly stamped: number;
  readonly stamped_spans: readonly string[];
  readonly unreadable: number;
  readonly unowned: number;
  readonly process_spans: readonly string[];
  readonly process_requests: number;
  readonly whole: boolean;
  readonly open: readonly { readonly gap: string; readonly [key: string]: unknown }[];
}

interface StepFacts {
  readonly text: string;
  readonly record: string;
  readonly observed: { readonly program_log?: { readonly trace_id: string } | null; readonly events?: EventsFacts | null };
  readonly events_late?: { readonly lines: number; readonly file: string | null };
}

interface RecordFacts {
  readonly result: { readonly file: string | null; readonly fileMode: number | null; readonly dirMode: number | null; readonly named: string[] } | null;
  readonly observed: StepFacts["observed"];
  readonly events_late?: unknown;
}

interface EventLine {
  readonly trace: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

const LINES = {
  rooms: 'When the client gets "/rooms/7"',
  scores: 'And the client posts to "/scores"',
  parked: 'And the client posts to "/scores?park=1"',
  secret: 'And the client gets "/secret"',
  spliced: 'And the client gets "/spliced"',
  late: 'And the client gets "/late"',
  wait: "And the step waits",
} as const;

/** Each step of every scenario of the latest run, by the key of the line
 * in LINES it ran. */
function scenarioSteps(rootDir: string): Map<string, StepFacts>[] {
  const run = latestRunJson(rootDir);
  return (run.scenarios as { steps: StepFacts[] }[]).map(
    (scenario) => new Map(scenario.steps.map((step) => [Object.entries(LINES).find(([, line]) => line.endsWith(step.text))?.[0] ?? step.text, step])),
  );
}

function recordOf(rootDir: string, step: StepFacts): RecordFacts {
  return JSON.parse(readFileSync(path.join(latestRunDir(rootDir), step.record, "record.json"), "utf8")) as RecordFacts;
}

function linesIn(file: string): EventLine[] {
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as EventLine);
}

function sliceOf(rootDir: string, step: StepFacts): EventLine[] {
  const file = step.observed.events?.file;
  if (file === null || file === undefined) return [];
  return linesIn(path.join(latestRunDir(rootDir), step.record, file));
}

/** The span ids of the requests the step sent with nukadoko's
 * traceparent, from its http.jsonl, in the order sent. */
function spansSent(rootDir: string, step: StepFacts): string[] {
  const file = path.join(latestRunDir(rootDir), step.record, "http.jsonl");
  if (!existsSync(file)) return [];
  const sent = readFileSync(file, "utf8").trimEnd().split("\n").map((text) => (JSON.parse(text) as { traceparent?: string }).traceparent ?? "");
  const own = new RegExp(`^00-${step.observed.program_log!.trace_id}-([0-9a-f]{16})-01$`);
  return sent.flatMap((value) => own.exec(value)?.slice(1, 2) ?? []);
}

/** What a reading of one step's events is, with its trace id. Its
 * span ids are checked against http.jsonl apart (expectOnePass). */
function reading(step: StepFacts, rest: Partial<EventsFacts>): EventsFacts {
  return {
    trace_id: step.observed.program_log!.trace_id,
    lines: 0,
    file: null,
    kinds: {},
    stamped: 1,
    stamped_spans: expect.any(Array) as unknown as string[],
    unreadable: 0,
    unowned: 0,
    process_spans: [],
    process_requests: 0,
    whole: true,
    open: [],
    ...rest,
  };
}

/** Every step of one pass over events.feature reads what its request did. */
function expectOnePass(rootDir: string, steps: Map<string, StepFacts>): void {
  const step = (key: keyof typeof LINES): StepFacts => {
    const found = steps.get(key);
    expect(found, key).toBeDefined();
    return found!;
  };
  for (const key of Object.keys(LINES) as (keyof typeof LINES)[]) {
    for (const line of sliceOf(rootDir, step(key))) expect(line.trace).toMatch(new RegExp(`^00-${step(key).observed.events!.trace_id}-[0-9a-f]{16}-01$`));
    // A reading of the record later matches each request to its line by these.
    expect(step(key).observed.events!.stamped_spans, key).toEqual(spansSent(rootDir, step(key)));
    expect(step(key).observed.events!.stamped_spans).toHaveLength(step(key).observed.events!.stamped);
  }

  expect(step("rooms").observed.events).toEqual(reading(step("rooms"), { lines: 2, file: "events.jsonl", kinds: { db: 1, request: 1 } }));
  expect(sliceOf(rootDir, step("rooms")).map((line) => line.kind)).toEqual(["db", "request"]);

  // The worker is a process of its own; its perform line closes the job
  // the server enqueued, so the step's work is whole.
  expect(step("scores").observed.events).toEqual(reading(step("scores"), { lines: 5, file: "events.jsonl", kinds: { db: 2, job: 2, request: 1 } }));
  expect(sliceOf(rootDir, step("scores")).filter((line) => line.kind === "job").map((line) => line.phase)).toEqual(["enqueue", "perform"]);

  const parked = sliceOf(rootDir, step("parked")).find((line) => line.kind === "job");
  expect(step("parked").observed.events).toEqual(
    reading(step("parked"), { lines: 3, file: "events.jsonl", kinds: { db: 1, job: 1, request: 1 }, whole: false, open: [{ gap: "jobs-pending", job_ids: [parked!.job_id] }] }),
  );

  expect(step("secret").observed.events).toEqual(reading(step("secret"), { lines: 2, file: "events.jsonl", kinds: { db: 1, request: 1 } }));
  expect(sliceOf(rootDir, step("secret"))[0]!.x_note).toBe("token {{secret.WORLD_TOKEN}}");

  // The line split around the flag line takes the flag line with it: its
  // first half carries the step's trace id, so the step counts one line it
  // could not read, and the request line is all it read.
  expect(step("spliced").observed.events).toEqual(
    reading(step("spliced"), { lines: 1, file: "events.jsonl", kinds: { request: 1 }, unreadable: 1, whole: false, open: [{ gap: "unreadable", lines: 1 }] }),
  );

  // The request line came 600 ms after the answer: after the step's
  // record, which is never written again.
  expect(step("late").observed.events).toEqual(reading(step("late"), { whole: false, open: [{ gap: "no-lines" }] }));
  expect(step("late").events_late).toEqual({ lines: 1, file: "events-late.jsonl" });
  expect(recordOf(rootDir, step("late")).events_late).toBeUndefined();
  expect(linesIn(path.join(latestRunDir(rootDir), step("late").record, "events-late.jsonl")).map((line) => line.route)).toEqual(["/late"]);
}

describe("the program's execution events", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("gives each step the lines that carry its trace id, from the server and the worker it started, and says what of its work is still open", async () => {
    const { exitCode } = await cli(rootDir, ["run"]);

    expect(exitCode).toBe(0);
    const [steps] = scenarioSteps(rootDir);
    expectOnePass(rootDir, steps!);

    // The file the program wrote is private, outside the run directory,
    // and named by the one variable the program file named.
    const inlet = recordOf(rootDir, steps!.get("wait")!).result!;
    expect(path.isAbsolute(inlet.file!)).toBe(true);
    expect(path.relative(rootDir, inlet.file!).startsWith("..")).toBe(true);
    expect(inlet.named).toEqual(["EXECUTION_EVENTS"]);
    if (process.platform !== "win32") expect([inlet.fileMode, inlet.dirMode]).toEqual([0o600, 0o700]);
    expect(existsSync(path.dirname(inlet.file!))).toBe(false);

    // 18 lines: one for the ready check, which carries no trace of the
    // world, 15 the steps' trace ids carry, one of them late, and the two
    // halves of the spliced line.
    const run = latestRunJson(rootDir);
    expect(run.worlds[0].events).toEqual({ file: "worlds/default/events.jsonl", lines: 18, owned: 15, late: 1, unowned: 1, unreadable: 2, undefined_kinds: {} });
    const copy = readFileSync(path.join(latestRunDir(rootDir), "worlds", "default", "events.jsonl"), "utf8").trimEnd().split("\n");
    expect(copy).toHaveLength(18);
    expect(copy.filter((line) => line.includes('"x_note"'))).toEqual([expect.stringContaining('"x_note":"token {{secret.WORLD_TOKEN}}"')]);
    // The one flag line went down with the spliced line around it, so no
    // step read a flag, and run.json names none.
    expect(run).not.toHaveProperty("flags");
    expect(readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8")).not.toContain("## Flags");

    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
    expect(summary.filter((line) => line.includes("events of world"))).toEqual([
      "- events of world default: 1 line carrying a step's trace id arrived after that step ended (`events-late.jsonl`); " +
        "2 lines are not one readable line of the format; the whole file is in `worlds/default/events.jsonl`",
    ]);
    expect(summary.filter((line) => line.includes("events-late.jsonl") && !line.includes("events of world"))).toEqual([
      "A line of the program's events that carries a step's trace id and arrived after its record was written is in that step's `events-late.jsonl`, and not in its record.",
      `- \`features/events.feature:9\` the client gets "/late": 1 line of the program's events after the step ended, in \`events-late.jsonl\`; record \`${steps!.get("late")!.record}\``,
    ]);
  });

  it("reads the same file in every worker under --concurrency, each step its own lines", async () => {
    await copyFile(path.join(rootDir, "features", "events.feature"), path.join(rootDir, "features", "events-again.feature"));
    const { exitCode } = await cli(rootDir, ["run", "--concurrency", "2"]);

    expect(exitCode).toBe(0);
    const passes = scenarioSteps(rootDir);
    expect(passes).toHaveLength(2);
    for (const steps of passes) expectOnePass(rootDir, steps);
    const traces = passes.flatMap((steps) => [...steps.values()].map((step) => step.observed.events!.trace_id));
    expect(new Set(traces).size).toBe(14);
    expect(latestRunJson(rootDir).worlds[0].events).toMatchObject({ lines: 35, owned: 30, late: 2, unowned: 1, unreadable: 4 });
  });

  // nuka do stops the world right after its one step, and the program
  // writes the line it held when it is told to stop, which Windows does by
  // ending the process at once.
  it.runIf(process.platform !== "win32")("nuka do names an events line that arrived after the step on stderr, beside the record it writes", async () => {
    const { exitCode, stdout, stderr } = await cli(rootDir, ["do", "get", "--args", JSON.stringify({ path: "/late" })]);

    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout) as { step_record_id: string; observed: StepFacts["observed"] };
    expect(record.observed.events).toMatchObject({ lines: 0, file: null, whole: false, open: [{ gap: "no-lines" }] });
    const late = path.join(".nukadoko", "do", record.step_record_id, "events-late.jsonl");
    expect(stderr).toContain(
      `note\tevents-late\t-\tworld default: 1 line(s) of the program's execution events carry the step's trace id and arrived after the step ended; see ${late}`,
    );
    expect(linesIn(path.join(rootDir, late)).map((line) => line.route)).toEqual(["/late"]);
  });

  it("gives a runCommand process the step's TRACEPARENT in place of an inherited one, and owns the lines of the request the process sent with it", async () => {
    const own = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await writeFile(
      path.join(rootDir, "features", "events.feature"),
      ["Feature: f", "", "  Scenario: s", '    When the tool gets "/rooms/7"', '    And the tool gets "/rooms/8" under a trace of its own', ""].join("\n"),
    );
    // nukadoko itself runs under a traced CI runner's TRACEPARENT, which
    // a step that spreads process.env passes on without choosing it.
    const inherited = process.env.TRACEPARENT;
    process.env.TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";
    let exitCode: number;
    try {
      ({ exitCode } = await cli(rootDir, ["run"]));
    } finally {
      if (inherited === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = inherited;
    }

    expect(exitCode).toBe(0);
    const [steps] = scenarioSteps(rootDir);
    interface ToolRecord {
      readonly result: { readonly traceparent: string };
      readonly observed: { readonly processes: readonly { readonly traceparent?: string }[] };
    }
    const toolRecord = (step: StepFacts): ToolRecord => recordOf(rootDir, step) as unknown as ToolRecord;

    const tool = steps!.get('the tool gets "/rooms/7"')!;
    const given = toolRecord(tool).observed.processes[0]!.traceparent!;
    const span = new RegExp(`^00-${tool.observed.events!.trace_id}-([0-9a-f]{16})-01$`).exec(given)?.[1];
    expect(span).toBeDefined();
    expect(toolRecord(tool).result.traceparent).toBe(given);
    expect(tool.observed.events).toEqual(
      reading(tool, {
        lines: 2,
        file: "events.jsonl",
        kinds: { db: 1, request: 1 },
        stamped: 0,
        stamped_spans: [],
        process_spans: [span!],
        process_requests: 1,
        whole: false,
        open: [{ gap: "processes-unbounded" }],
      }),
    );
    expect(sliceOf(rootDir, tool).find((line) => line.kind === "request")!.trace).toBe(given);

    // A TRACEPARENT the step chose is kept, so the lines of the tool's
    // request are no step's.
    const chosen = steps!.get('the tool gets "/rooms/8" under a trace of its own')!;
    expect(toolRecord(chosen).result.traceparent).toBe(own);
    expect(toolRecord(chosen).observed.processes[0]).not.toHaveProperty("traceparent");
    expect(chosen.observed.events).toEqual(reading(chosen, { stamped: 0, unowned: 2, whole: false, open: [{ gap: "processes-unbounded" }] }));
  });

  it("gives the program the variable that names {events} and keeps it from every step, under nuka run and nuka do", async () => {
    await writeFile(path.join(rootDir, "features", "events.feature"), ["Feature: f", "", "  Scenario: s", "    When the step reads its own env", "    And the step waits", ""].join("\n"));
    const { exitCode } = await cli(rootDir, ["run"]);

    expect(exitCode).toBe(0);
    const [steps] = scenarioSteps(rootDir);
    expect(recordOf(rootDir, steps!.get("the step reads its own env")!).result).toEqual({ named: [] });
    expect(recordOf(rootDir, steps!.get("wait")!).result!.named).toEqual(["EXECUTION_EVENTS"]);

    const done = await cli(rootDir, ["do", "own-env", "--args", "{}"]);
    expect(done.exitCode).toBe(0);
    expect((JSON.parse(done.stdout) as { result: unknown }).result).toEqual({ named: [] });
  });

  it("makes no file and sets no variable for a world whose program file does not name {events}", async () => {
    const program = path.join(rootDir, "nukadoko.program.ts");
    await writeFile(program, readFileSync(program, "utf8").replace(' EXECUTION_EVENTS: "{events}",', ""));
    await writeFile(
      path.join(rootDir, "features", "events.feature"),
      ["Feature: f", "", "  Scenario: s", '    When the client gets "/rooms/7"', '    And customer "kim" opens order 7', "    And the step waits", ""].join("\n"),
    );
    const { exitCode } = await cli(rootDir, ["run"]);

    expect(exitCode).toBe(0);
    const [steps] = scenarioSteps(rootDir);
    expect(steps!.size).toBe(3);
    for (const step of steps!.values()) expect(step.observed).not.toHaveProperty("events");
    expect(recordOf(rootDir, steps!.get("wait")!).result).toEqual({ file: null, fileMode: null, dirMode: null, named: [] });
    expect(latestRunJson(rootDir).worlds[0]).not.toHaveProperty("events");
    // The order page evaluated the flag, but no file took the line.
    expect(latestRunJson(rootDir)).not.toHaveProperty("flags");
    expect(existsSync(path.join(latestRunDir(rootDir), "worlds", "default", "events.jsonl"))).toBe(false);
    expect(readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8")).not.toContain("events of world");
  });
});

describe("execution events of a world at a URL", () => {
  let rootDir: string;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("events-project");
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ file: null, fileMode: null, dirMode: null, named: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await removeTempDir(rootDir);
  });

  it("records null on every step, and says once why nothing was read", async () => {
    await writeUrlProgram(rootDir, url);
    await writeFile(path.join(rootDir, "features", "events.feature"), `${readFileSync(path.join(rootDir, "features", "events.feature"), "utf8")}    And customer "kim" opens order 7\n`);
    const { exitCode } = await cli(rootDir, ["run"]);

    expect(exitCode).toBe(0);
    const [steps] = scenarioSteps(rootDir);
    expect(steps!.size).toBe(8);
    for (const step of steps!.values()) {
      expect(step.observed.events).toBeNull();
      expect(recordOf(rootDir, step).observed.events).toBeNull();
    }
    expect(latestRunJson(rootDir).worlds[0].events).toBeNull();
    // The order page is a step that evaluates the flag where nukadoko
    // reads lines; here it reads none, so run.json names no flag.
    expect(latestRunJson(rootDir)).not.toHaveProperty("flags");
    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8").split("\n");
    expect(summary.filter((line) => line.includes("events of world"))).toEqual([
      `- events of world default: not read, since the program runs at ${url}, which nukadoko did not start`,
    ]);
  });

  it("refuses {events} by name before anything runs", async () => {
    await writeUrlProgram(rootDir, url, 'env: { EXECUTION_EVENTS: "{events}" }');
    const gap = "world default: env.EXECUTION_EVENTS names {events}, which has no value here: nukadoko does not start this world's program, so it reads no file the program writes";
    const fix =
      "  fix: Remove {events} from env.EXECUTION_EVENTS of nukadoko.program.ts, or serve world default in place of its url: nukadoko makes the events file only for a program it starts.\n";

    const check = await cli(rootDir, ["check"]);
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toContain(`error\tprogram-placeholder-unfilled\tnukadoko.program.ts\t${gap}\n${fix}`);
    const refused = await cli(rootDir, ["run", "--no-check"]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toBe(`refused\tprogram-placeholder-unfilled\t-\t${gap}; nothing ran\n${fix}`);
  });
});
