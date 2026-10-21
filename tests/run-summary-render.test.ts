import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { RunDocument, RunScenario, RunStep } from "../src/record/run-result.js";
import { renderRunSummary } from "../src/run/run-summary.js";
import { foldVerdicts } from "../src/run/verdicts.js";

// Responsibility: the exact Markdown of the run summary, rendered from
// literal run.json documents: a green run, a red run, a run over two
// environments under `--repeat`, and a run whose step declared
// `mutates: false` and was measured writing. The properties are that every
// scenario of a run gets exactly one row, whatever its name, feature, or
// line, and that the title says the document's verdict, so a reader never
// reads a run with a scenario missing, counted twice, or with a verdict
// run.json does not hold.

const base: RunDocument = {
  schema_version: 2,
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
        "## Declared vs observed",
        "",
        "No step declared `mutates: false` and was measured making a write.",
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
              observed: { http_reads: null, http_writes: null, processes: null },
            }),
            step("the error <b>Locked</b> is shown", {
              status: "failed",
              record: "steps/stp-1",
              mutates: false,
              observed: {
                http_reads: null,
                http_writes: null,
                processes: [
                  { command: ["npm", "run", "migrate"], cwd: "/tmp/x", exit_code: 0, duration_ms: 5 },
                  { command: ["npm", "run", "seed"], cwd: "/tmp/x", exit_code: 1, duration_ms: 5 },
                ],
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
        "## Declared vs observed",
        "",
        "No step declared `mutates: false` and was measured making a write.",
        "",
        "1 step that declared `mutates: false` reached no HTTP channel nukadoko observes (`request`, `page`, `context`, `pageAs`), so nothing was compared for it.",
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
        "## Declared vs observed",
        "",
        "No step declared `mutates: false` and was measured making a write.",
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

  it("lists a step that declared mutates: false and was measured writing", () => {
    const observed = (writes: number | null) =>
      writes === null
        ? { http_reads: null, http_writes: null, processes: null }
        : { http_reads: 0, http_writes: writes, processes: null };
    const markdown = renderRunSummary(run({
      scenarios: [
        scenario("features/a.feature", 2, "a report is read", "passed", 10, {
          steps: [
            step("the report is fetched", { mutates: false, observed: observed(1) }),
            step("the cache is read", { mutates: false, observed: observed(0) }),
            step("a compat step", { mutates: null, observed: observed(0) }),
            step("another compat step", { mutates: null, observed: observed(null) }),
            step("a fetch", { mutates: false, observed: observed(null) }),
            step("a write", { mutates: true, observed: observed(3) }),
            step("a step that never began", { status: "undefined", step: null }),
          ],
        }),
      ],
    }));
    expect(markdown.slice(markdown.indexOf("## Declared vs observed"))).toBe(
      [
        "## Declared vs observed",
        "",
        "Steps that declared `mutates: false` and were measured making writes. This is a comparison, not a verdict: a step that reads over POST records writes by design.",
        "",
        '- "the report is fetched" (scenario "a report is read"): declared mutates: false, observed 1 write',
        "",
        "1 step that declared `mutates: false` reached no HTTP channel nukadoko observes (`request`, `page`, `context`, `pageAs`), so nothing was compared for it.",
        "",
        "2 compat steps have no `mutates` declaration to compare.",
        "",
      ].join("\n"),
    );
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
