import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { RunDocument, RunScenario, RunStep, RunWorld } from "../src/record/run-result.js";
import type { UnmeasuredEntry } from "../src/record/types.js";
import { renderRunSummary } from "../src/run/run-summary.js";
import { foldVerdicts } from "../src/run/verdicts.js";

// Responsibility: the exact Markdown of the run summary, rendered from
// literal run.json documents: a green run, a red run, and a run over two
// environments under `--repeat`. The properties are that every scenario of
// a run gets exactly one row, whatever its name, feature, or line, and that
// the title says the document's verdict, so a reader never reads a run with
// a scenario missing, counted twice, or with a verdict run.json does not
// hold.

const base: RunDocument = {
  schema_version: 3,
  nukadoko: "0.14.1",
  command: "run",
  verdict: "passed",
  findings: [],
  run_id: "run-20261015-120000-abcd",
  started_at: "2026-10-15T12:00:00.000Z",
  finished_at: "2026-10-15T12:01:05.000Z",
  commit: { sha: "0123456789abcdef0123456789abcdef01234567", dirty: false },
  environments: [{ name: "default", target_version: null }],
  selection: "full",
  counts: { scenarios: 0, passed: 0, failed: 0, not_run: 0 },
  scenarios: [],
  verdicts: [],
};

// A document whose `verdicts` fold its own scenarios, as `nuka run` writes
// them.
function run(over: Partial<RunDocument>): RunDocument {
  const document = { ...base, ...over };
  return {
    ...document,
    verdicts: foldVerdicts(
      document.scenarios,
      document.environments.map((environment) => environment.name),
    ),
  };
}

function scenario(
  feature: string,
  line: number,
  name: string,
  status: "passed" | "failed",
  durationMs: number,
  extra: Partial<RunScenario> = {},
): RunScenario {
  const started = Date.parse("2026-10-15T12:00:10.000Z");
  return {
    scenario_record_id: `scn-${line}`,
    feature,
    line,
    scenario: name,
    environment: "default",
    status,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(started + durationMs).toISOString(),
    steps: [],
    hooks: [],
    ...extra,
  };
}

function step(text: string, extra: Partial<RunStep> = {}): RunStep {
  return { line: 4, text, step: "a-step", status: "passed", step_record_id: null, record: null, ...extra };
}

describe("renderRunSummary", () => {
  it("names each step with unmeasured actions or actions started after it ended on one line, and adds nothing for the others", () => {
    const quiet = { processes: null, http: 2, files: null, unmeasured: [] };
    const gap = (unmeasured: UnmeasuredEntry[]) => ({
      processes: null,
      http: null,
      files: null,
      unmeasured,
    });
    const markdown = renderRunSummary(run({
      scenarios: [
        scenario("features/sync.feature", 3, "the mirror syncs", "passed", 100, {
          steps: [
            step("the mirror is fetched", {
              line: 4,
              record: "steps/stp-1",
              observed: gap([
                { kind: "child_process", detail: "exec git with 2 arguments" },
                { kind: "socket", detail: "connect db.internal:5432" },
              ]),
            }),
            step("the count is shown", { line: 5, record: "steps/stp-2", observed: quiet }),
            step("the mirror is pinged", { line: 6, record: "steps/stp-4", observed: quiet, after_step_end: { requests: 2, processes: 1, http: "http.jsonl" } }),
            step("the mirror is closed", {
              line: 7,
              record: "steps/stp-5",
              observed: gap([{ kind: "socket", detail: "write to db.internal:5432, a connection opened before the step" }]),
              after_step_end: { requests: 0, processes: 1 },
            }),
          ],
        }),
        scenario("features/sync.feature", 9, "the report renders", "passed", 100, {
          steps: [
            step("the report is built", {
              line: 10,
              record: "steps/stp-3",
              observed: gap([
                { kind: "worker_thread", detail: "new Worker ./render.js" },
                { kind: "child_process", detail: "spawn convert with 2 arguments" },
                { kind: "child_process", detail: "spawn optipng with 1 argument" },
                { kind: "socket", detail: "connect /tmp/render.sock" },
              ]),
            }),
          ],
        }),
      ],
    }));
    expect(markdown.split("\n").slice(-10)).toEqual([
      "## Unmeasured actions",
      "",
      "Each step below did something nukadoko records but cannot measure, so its record has no evidence of what that action did.",
      "An action a step started after its record was written is in that step's own files, marked `after_step_end`, and not in its record.",
      "",
      "- `features/sync.feature:4` the mirror is fetched: child process `exec git with 2 arguments`, socket `connect db.internal:5432`; start a process with `runCommand` to record it; record `steps/stp-1`",
      "- `features/sync.feature:6` the mirror is pinged: started after the step ended: 2 requests in `http.jsonl`, 1 process; record `steps/stp-4`",
      "- `features/sync.feature:7` the mirror is closed: socket `write to db.internal:5432, a connection opened before the step`, started after the step ended: 1 process; record `steps/stp-5`",
      "- `features/sync.feature:10` the report is built: worker thread `new Worker ./render.js`, child process `spawn convert with 2 arguments`, child process `spawn optipng with 1 argument`, and 1 more; start a process with `runCommand` to record it; record `steps/stp-3`",
      "",
    ]);
    expect(renderRunSummary(run({
      scenarios: [scenario("features/sync.feature", 3, "the mirror syncs", "passed", 100, { steps: [step("the count is shown", { observed: quiet })] })],
    }))).not.toContain("Unmeasured");
  });

  it("renders a green run", () => {
    const markdown = renderRunSummary(run({
      scenarios: [
        scenario("features/login.feature", 9, "a wrong password is refused", "passed", 800, {
          browser: { type: "chromium", version: "141.0.7390.37" },
        }),
        scenario("features/cart.feature", 3, "an item is added", "passed", 1250),
        scenario("features/login.feature", 3, "a member signs in", "passed", 2049, {
          browser: { type: "chromium", version: "141.0.7390.37" },
        }),
      ],
    }));
    expect(markdown).toBe(
      [
        "<!-- nukadoko:run -->",
        "# nukadoko run passed: 3 scenarios, 3 passed",
        "",
        "- commit: `0123456`",
        "- environment: default",
        "- browser: chromium 141.0.7390.37",
        "- selection: full",
        "- nukadoko: 0.14.1",
        "- run: run-20261015-120000-abcd",
        "- started 2026-10-15T12:00:00.000Z, finished 2026-10-15T12:01:05.000Z (1m 5s)",
        "",
        "## features/cart.feature",
        "",
        "| scenario | line | default | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        "| an item is added | 3 | passed | 1.3s |  |",
        "",
        "## features/login.feature",
        "",
        "| scenario | line | default | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        "| a member signs in | 3 | passed | 2.0s |  |",
        "| a wrong password is refused | 9 | passed | 0.8s |  |",
        "",
      ].join("\n"),
    );
  });

  it("renders a red run with the failing step, its error, what it ran, and how to rerun it", () => {
    const markdown = renderRunSummary(run({
      verdict: "failed",
      environments: [{ name: "staging", target_version: "2.4.0", base_url: "https://staging.example.test" }],
      commit: { sha: "fedcba9876543210fedcba9876543210fedcba98", dirty: true },
      selection: "partial",
      scenarios: [
        scenario("features/login.feature", 3, "a member signs in", "passed", 1000, { environment: "staging" }),
        scenario("features/login.feature", 9, "a wrong password | is refused", "failed", 400, {
          environment: "staging",
          steps: [
            step("the seed ran", {
              record: "steps/stp-0",
              mutates: true,
              observed: { processes: null, http: null, files: null, unmeasured: [] },
            }),
            step("the error <b>Locked</b> is shown", {
              status: "failed",
              record: "steps/stp-1",
              mutates: false,
              observed: {
                processes: [
                  { command: ["npm", "run", "migrate"], cwd: "/tmp/x", exit_code: 0, duration_ms: 5 },
                  { command: ["npm", "run", "seed"], cwd: "/tmp/x", exit_code: 1, duration_ms: 5 },
                ],
                http: null,
                files: null,
                unmeasured: [],
              },
              error: { kind: "step_error", message: "expected `Locked` | got `Open`\nmore detail" },
              used: [
                { step: "the-seed-ran", record: "steps/stp-0", result: { exitCode: 2, stdout: "", stderr: "\nseed: no database\n" } },
              ],
            }),
            step("the page is shown", { status: "skipped" }),
          ],
          do: "nuka run features/login.feature:9 --env staging",
        }),
        scenario("features/login.feature", 15, "a session expires", "failed", 0, {
          environment: "staging",
          hooks: [{ type: "before", status: "failed", error: { kind: "step_error", message: "" } }],
          evidence: { dir: "scenarios/scn-2", screenshots: [] },
          do: "nuka run features/login.feature:15 --env staging",
        }),
      ],
    }));
    expect(markdown).toBe(
      [
        "<!-- nukadoko:run -->",
        "# nukadoko run failed: 3 scenarios, 1 passed, 2 failed",
        "",
        "- commit: `fedcba9` with uncommitted changes",
        "- environment: staging at https://staging.example.test (target version 2.4.0)",
        "- browser: none launched",
        "- selection: partial (a line target left out other scenarios of its file)",
        "- nukadoko: 0.14.1",
        "- run: run-20261015-120000-abcd",
        "- started 2026-10-15T12:00:00.000Z, finished 2026-10-15T12:01:05.000Z (1m 5s)",
        "",
        "## features/login.feature",
        "",
        "| scenario | line | staging | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        "| a member signs in | 3 | passed | 1.0s |  |",
        '| a wrong password \\| is refused | 9 | failed | 0.4s | step "the error &lt;b>Locked&lt;/b> is shown": `` expected `Locked` \\| got `Open` ``<br>used the-seed-ran exit 2: `seed: no database`<br>ran `npm run seed`<br>record `steps/stp-1` |',
        "| a session expires | 15 | failed | 0.0s | Before hook: `(no message)`<br>record `scenarios/scn-2` |",
        "",
        "## Rerun a failed scenario",
        "",
        "```sh",
        "nuka run features/login.feature:9 --env staging",
        "nuka run features/login.feature:15 --env staging",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("draws one column per environment, and a cell per scenario and environment under --repeat", () => {
    const at = (environment: string, status: "passed" | "failed", extra: Partial<RunScenario> = {}) =>
      scenario("features/flag.feature", 4, "the banner is shown", status, 500, { environment, ...extra });
    const markdown = renderRunSummary(run({
      verdict: "failed",
      environments: [
        { name: "flag-on", target_version: null },
        { name: "flag-off", target_version: "1.2.0" },
      ],
      scenarios: [
        at("flag-on", "passed"),
        at("flag-on", "passed"),
        at("flag-off", "failed", {
          steps: [step("the banner is shown", { status: "failed", record: "steps/stp-9", error: { kind: "step_error", message: "no banner" } })],
          do: "nuka run features/flag.feature:4 --env flag-off",
        }),
        at("flag-off", "passed"),
        scenario("features/flag.feature", 9, "the page loads", "passed", 250, { environment: "flag-on" }),
        scenario("features/flag.feature", 9, "the page loads", "passed", 250, { environment: "flag-on" }),
        scenario("features/flag.feature", 9, "the page loads", "passed", 250, { environment: "flag-off" }),
        scenario("features/flag.feature", 9, "the page loads", "passed", 250, { environment: "flag-off" }),
      ],
    }));
    expect(markdown).toBe(
      [
        "<!-- nukadoko:run -->",
        "# nukadoko run failed: 2 scenarios in 2 environments, 3 passed, 1 failed",
        "",
        "- commit: `0123456`",
        "- environment: flag-on",
        "- environment: flag-off (target version 1.2.0)",
        "- browser: none launched",
        "- selection: full",
        "- nukadoko: 0.14.1",
        "- run: run-20261015-120000-abcd",
        "- started 2026-10-15T12:00:00.000Z, finished 2026-10-15T12:01:05.000Z (1m 5s)",
        "",
        "## features/flag.feature",
        "",
        "| scenario | line | flag-on | flag-off | duration | failure |",
        "| --- | --- | --- | --- | --- | --- |",
        '| the banner is shown | 4 | 2 of 2 passed | 1 of 2 passed | 2.0s | flag-off: step "the banner is shown": `no banner`<br>record `steps/stp-9` |',
        "| the page loads | 9 | 2 of 2 passed | 2 of 2 passed | 1.0s |  |",
        "",
        "## Rerun a failed scenario",
        "",
        "```sh",
        "nuka run features/flag.feature:4 --env flag-off",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("names a world whose program did not start, with its log, and a hook failure beside it", () => {
    const unstarted = { ...world("default", "http://localhost:41563"), log: "worlds/default/program.log", error: "serve command node app/server.mjs exited with code 4" };
    const failedStart = { severity: "failed" as const, code: "program-start-failed", message: "the program did not start for world default" };
    const headline = (findings: RunDocument["findings"]): string =>
      renderRunSummary(run({ verdict: "failed", run_dir: ".nukadoko/runs/run-1", worlds: [unstarted], findings, scenarios: [] })).split("\n")[3]!;

    expect(headline([failedStart])).toBe(
      "No scenario failed, but the run did. The program did not start for world default (`program-start-failed`), so no scenario ran there; " +
        "its log is `.nukadoko/runs/run-1/worlds/default/program.log`. The findings below say why.",
    );
    expect(headline([failedStart, { severity: "failed", code: "hook-failed", message: "AfterAll: x" }])).toContain(
      "A BeforeAll or AfterAll hook, or a worker that wrote no scenario, also failed outside every scenario. The findings below say why.",
    );
  });

  it("says when the run failed outside every scenario, and lists the findings that say why", () => {
    const markdown = renderRunSummary(run({
      verdict: "failed",
      commit: null,
      findings: [
        { severity: "failed", code: "hook-failed", message: "AfterAll: the <db> did not stop" },
        { severity: "warning", code: "summary-not-written", message: "the run summary was not written to out.md: EACCES" },
      ],
      scenarios: [scenario("features/a.feature", 2, "s", "passed", 10)],
    }));
    expect(markdown.split("\n").slice(0, 6)).toEqual([
      "<!-- nukadoko:run -->",
      "# nukadoko run failed: 1 scenario, 1 passed",
      "",
      "No scenario failed, but the run did: a BeforeAll or AfterAll hook, or a worker that wrote no scenario, failed outside every scenario. The findings below name it.",
      "",
      "- commit: unknown (no git state was readable when the run started)",
    ]);
    expect(markdown.slice(markdown.indexOf("## Findings"))).toBe(
      [
        "## Findings",
        "",
        "- failed `hook-failed` -: AfterAll: the &lt;db> did not stop",
        "- warning `summary-not-written` -: the run summary was not written to out.md: EACCES",
        "",
      ].join("\n"),
    );
  });

  it("counts and draws a scenario its BeforeAll kept from running as not run", () => {
    const markdown = renderRunSummary({
      ...base,
      verdict: "failed",
      commit: null,
      findings: [{ severity: "failed", code: "hook-failed", message: 'BeforeAll failed in environment "default": boom', do: "nuka run" }],
      counts: { scenarios: 0, passed: 0, failed: 0, not_run: 1 },
      verdicts: foldVerdicts([], ["default"], [{ feature: "features/a.feature", line: 2, scenario: "s" }]),
    });
    expect(markdown.split("\n").slice(1, 2)).toEqual(["# nukadoko run failed: 1 scenario, 0 passed, 1 not run"]);
    expect(markdown).toContain("| s | 2 | not run | 0.0s |  |\n");
  });

  const scenariosGen = gs.arrays(
    gs.composite((inner) =>
      scenario(
        `features/${inner.draw(gs.sampledFrom(["a", "b", "c d", "e|f"]))}.feature`,
        inner.draw(gs.integers({ minValue: 1, maxValue: 400 })),
        inner.draw(gs.text({ maxSize: 20, alphabet: "abc |<>`*_" })),
        inner.draw(gs.sampledFrom(["passed", "failed"] as const)),
        0,
        {
          steps: [
            step(inner.draw(gs.text({ maxSize: 10, alphabet: "ab|`<" })), {
              status: inner.draw(gs.sampledFrom(["passed", "failed", "undefined"] as const)),
              error: { kind: null, message: inner.draw(gs.text({ maxSize: 20, alphabet: "ab|`<\n" })) },
            }),
          ],
        },
      ),
    ),
    { maxSize: 12 },
  );

  // One execution per scenario: the generated lines are made distinct, so
  // a row and an execution are the same thing here.
  const distinct = (entries: readonly RunScenario[]): RunScenario[] =>
    entries.map((entry, index) => ({ ...entry, line: index + 1 }));

  it("gives every scenario of the run exactly one row", () =>
    hegel.test((tc) => {
      // Each row carries a unique duration, so a row can be traced back to
      // the one scenario it came from.
      const scenarios = distinct(tc.draw(scenariosGen)).map((entry, index) => ({
        ...entry,
        finished_at: new Date(Date.parse(entry.started_at) + index * 100_000).toISOString(),
      }));
      const markdown = renderRunSummary(run({ scenarios }));
      const rows = markdown.split("\n").filter((line) => /^\| .* \| (passed|failed) \| \d+\.\ds \|/.test(line));
      expect(rows).toHaveLength(scenarios.length);
      scenarios.forEach((_, index) => {
        const duration = `| ${(index * 100).toFixed(1)}s |`;
        expect(rows.filter((row) => row.includes(duration))).toHaveLength(1);
      });
    }));

  // cmark-gfm splits a row only on a `|` whose preceding character is not `\`,
  // and it removes that one backslash. A plain cell is then parsed as inline,
  // so `\` before ASCII punctuation disappears there too. A code span keeps
  // every other backslash. `<` in a plain cell is `&lt;` and reads back as `<`.
  const INLINE_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

  function splitTableRow(row: string): string[] {
    const cells: string[] = [];
    let current = "";
    for (let index = 0; index < row.length; index += 1) {
      const character = row[index]!;
      if (character === "\\" && row[index + 1] === "|") {
        current += "|";
        index += 1;
        continue;
      }
      if (character === "|") {
        cells.push(current.trim());
        current = "";
      } else current += character;
    }
    return cells;
  }

  function plainCell(cell: string): string {
    let text = "";
    for (let index = 0; index < cell.length; index += 1) {
      const character = cell[index]!;
      const next = cell[index + 1];
      if (character === "\\" && next !== undefined && INLINE_PUNCTUATION.includes(next)) {
        text += next;
        index += 1;
      } else text += character;
    }
    return text.replaceAll("&lt;", "<");
  }

  it("shows a backslash in a scenario name as that backslash", () =>
    hegel.test((tc) => {
      const name = tc.draw(gs.text({ minSize: 1, maxSize: 12, alphabet: "ab\\|<" }));
      const markdown = renderRunSummary(
        run({
          scenarios: [
            scenario("features/login.feature", 3, name, "failed", 100, {
              steps: [step("the step", { status: "failed", error: { kind: null, message: name } })],
            }),
          ],
        }),
      );
      const row = markdown.split("\n").find((line) => line.startsWith("| ") && !line.startsWith("| scenario") && !line.startsWith("| ---"));
      const cells = splitTableRow(row ?? "");
      expect(cells).toHaveLength(6);
      expect(plainCell(cells[1] ?? "")).toBe(name);
      expect(cells[5]?.match(/`([^`]*)`/)?.[1]).toBe(name);
    }));

  it("titles the summary with the document's verdict", () =>
    hegel.test((tc) => {
      const verdict = tc.draw(gs.sampledFrom(["passed", "failed"] as const));
      const scenarios = distinct(tc.draw(scenariosGen));
      const title = renderRunSummary(run({ verdict, scenarios })).split("\n")[1]!;
      const failed = scenarios.filter((entry) => entry.status === "failed").length;
      const counts = [`${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}`, `${scenarios.length - failed} passed`];
      if (failed > 0) counts.push(`${failed} failed`);
      expect(title).toBe(`# nukadoko run ${verdict}: ${counts.join(", ")}`);
    }));
});

// A world record as `nuka run` writes it.
function world(name: string, url: string | null): RunWorld {
  return { name, tree: "head", url, commands: [], timings: {}, log: null, error: null };
}

const NO_TRACE_IDS = "carries no trace ids";
const CAME_LATE = "arrived after that step ended";
const BUFFERED = "buffers its output on a pipe";

describe("the program log lines of the summary", () => {
  it("says once per world that a log was not read, carries no trace ids, or has late lines, and nothing for the others", () => {
    const markdown = renderRunSummary(
      run({
        environments: [
          { name: "default", target_version: null, base_url: "http://localhost:41873" },
          { name: "untagged", target_version: null, base_url: "http://localhost:41874" },
          { name: "buffered", target_version: null, base_url: "http://localhost:41876" },
          { name: "staging", target_version: null, base_url: "https://staging.example.test" },
          { name: "quiet", target_version: null, base_url: "http://localhost:41875" },
        ],
        worlds: [
          { ...world("default", "http://localhost:41873"), program_log: { stamped: 4, lines: 7, late: 2, tagged: 9 } },
          { ...world("untagged", "http://localhost:41874"), program_log: { stamped: 4, lines: 0, late: 0, tagged: 0 } },
          { ...world("buffered", "http://localhost:41876"), program_log: { stamped: 4, lines: 0, late: 8, tagged: 8 } },
          { ...world("staging", "https://staging.example.test"), program_log: null },
          { ...world("quiet", "http://localhost:41875"), program_log: { stamped: 0, lines: 0, late: 0, tagged: 0 } },
        ],
      }),
    );
    expect(markdown.split("\n").slice(3, 15)).toEqual([
      "- commit: `0123456`",
      "- environment: default at http://localhost:41873",
      "- environment: untagged at http://localhost:41874",
      "- environment: buffered at http://localhost:41876",
      "- environment: staging at https://staging.example.test",
      "- environment: quiet at http://localhost:41875",
      "- program log of world default: 2 lines carrying a step's trace id arrived after that step ended (`program-log-late.txt`).",
      "- program log of world untagged: carries no trace ids, so each step's slice of it is empty",
      "- program log of world buffered: 8 lines carrying a step's trace id arrived after that step ended (`program-log-late.txt`). " +
        "None of the steps' lines arrived in time, which is what a program that buffers its output on a pipe looks like; " +
        "if that is the cause, set `STDOUT.sync = true` in Ruby, or `PYTHONUNBUFFERED=1` for Python.",
      "- program log of world staging: not read, since the program runs at https://staging.example.test, which nukadoko did not start",
      "- browser: none launched",
      "- selection: full",
    ]);
  });

  it("says a log carries no trace ids only when no line of it carries one, counts its late lines, and offers buffering only when no line came in time", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
      const late = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
      // Hooks' lines carry the world's trace ids too.
      const tagged = lines + late + tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
      const stamped = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
      const markdown = renderRunSummary(run({ worlds: [{ ...world("default", "http://localhost:1"), program_log: { stamped, lines, late, tagged } }] }));
      expect(markdown.includes(NO_TRACE_IDS)).toBe(stamped > 0 && tagged === 0);
      expect(markdown.includes(CAME_LATE)).toBe(stamped > 0 && tagged > 0 && late > 0);
      expect(markdown.includes(BUFFERED)).toBe(stamped > 0 && tagged > 0 && lines === 0 && late > 0);
    }));

  it("names a step's late lines once under that step, and says when they could not be written", () => {
    const observed = { processes: null, http: 1, files: null, unmeasured: [] };
    const markdown = renderRunSummary(
      run({
        scenarios: [
          scenario("features/a.feature", 3, "slow", "passed", 1, {
            steps: [
              step("the step calls slow", { line: 4, record: "steps/step-1", observed, program_log_late: { lines: 2, file: "program-log-late.txt" } }),
              step("the step calls slow again", { line: 5, record: "steps/step-2", observed, program_log_late: { lines: 1, file: null } }),
              step("the step waits", { line: 6, record: "steps/step-3", observed }),
            ],
          }),
        ],
      }),
    );
    const section = markdown.slice(markdown.indexOf("## Unmeasured actions"));
    expect(section.split("\n").filter((line) => line.startsWith("- ") || line.includes("program-log-late"))).toEqual([
      "A line of the program's log that carries a step's trace id and arrived after its record was written is in that step's `program-log-late.txt`, and not in its record.",
      "- `features/a.feature:4` the step calls slow: 2 lines of the program's log after the step ended, in `program-log-late.txt`; record `steps/step-1`",
      "- `features/a.feature:5` the step calls slow again: 1 line of the program's log after the step ended, which could not be written; record `steps/step-2`",
    ]);
  });
});
