import { z } from "zod";
import { GAP_WORDS } from "../execution-events/tally.js";
import { formatValidationIssues } from "../issues/format-issues.js";
import type { RunDocument } from "../record/run-result.js";
import { isGeneratedId } from "../record/record-id.js";
import { ENVELOPE_SCHEMA_VERSION } from "../record/schema-version.js";

// Responsibility: the check a run.json passes before `nuka report` reads
// it. A run directory copied off a CI machine is untrusted input, and a
// field cast rather than checked fails later as a TypeError that names no
// file and no field. So the version is tested first, then every field a
// report reads, and a document that fails either is refused with what is
// wrong. "A report" is all three formats: the Markdown summary reads
// run.json directly, and Allure and the messages stream read it through
// the scenario records src/report/load-run.ts rebuilds, so the schema is
// the union of what the three read, optional fields included, and no
// renderer reads a field this boundary has not checked. Fields no report
// reads are not checked: a later release may add fields, and an added
// field does not move the version.

const errorKind = z.enum([
  "args_invalid",
  "result_invalid",
  "binding_invalid",
  "world_invalid",
  "timeout",
  "unsupported",
  "claim_broken",
  "unobserved",
  "claim_unjudged",
  "step_error",
]);

// What the summary reads of one claim (src/report/summary/claim-line.ts).
const claimOutcome = z.enum(["held", "broken", "unobserved", "unjudged"]);

const measuredChannel = z.looseObject({ step_record_id: z.string(), channel: z.string() });

const comparisonClaim = z.looseObject({
  actual: z.unknown().optional(),
  actual_from: z.string(),
  view: z.string().optional(),
  at: z.string().optional(),
  compare: z.string(),
  expected: z.unknown().optional(),
  expected_from: z.string(),
  expected_measured: measuredChannel.nullable().optional(),
  outcome: claimOutcome,
  reason: z.string().optional(),
  measured: measuredChannel.nullable().optional(),
});

const itemDeclaration = z.looseObject({
  actual: z.string().optional(),
  view: z.string().optional(),
  at: z.string().optional(),
  compare: z.string(),
  expected: z.unknown().optional(),
  expected_from: z.string(),
  expected_measured: measuredChannel.nullable().optional(),
});

const eachClaim = z.looseObject({
  actual_from: z.string(),
  view: z.string().optional(),
  at: z.string().optional(),
  each: z.looseObject({
    where: z.array(itemDeclaration).optional(),
    claims: z.array(itemDeclaration),
    items: z.number().int(),
    selected: z.number().int(),
    results: z.array(
      z.union([
        z.looseObject({
          index: z.number().int(),
          selected: z.literal(true),
          outcome: z.enum(["held", "broken", "unjudged"]),
          claims: z.array(comparisonClaim),
          identity: z.object({ field: z.string(), value: z.union([z.string(), z.number()]) }).optional(),
        }),
        z.looseObject({ index: z.number().int(), selected: z.literal(false), where: z.array(comparisonClaim) }),
      ]),
    ),
  }),
  outcome: claimOutcome,
  reason: z.string().optional(),
  measured: measuredChannel.nullable().optional(),
});

const process = z.looseObject({
  command: z.array(z.string()),
  cwd: z.string(),
  exit_code: z.number().int().nullable(),
  signal: z.string().optional(),
  timed_out: z.literal(true).optional(),
  duration_ms: z.number(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  files: z
    .union([
      z.looseObject({
        added: z.array(z.string()),
        changed: z.array(z.string()),
        removed: z.array(z.string()),
        skipped: z.array(z.string()).optional(),
      }),
      z.looseObject({ unmeasured: z.string() }),
    ])
    .optional(),
});

const observed = z.looseObject({
  processes: z.array(process).nullable(),
  http: z.number().int().nullable(),
  files: z
    .array(z.looseObject({ path: z.string(), change: z.enum(["added", "changed", "removed"]), bytes: z.number().int().optional() }))
    .nullable(),
  unmeasured: z.array(z.looseObject({ kind: z.enum(["child_process", "worker_thread", "socket", "files", "page_request"]), detail: z.string() })),
  program_log: z
    .looseObject({ trace_id: z.string(), lines: z.number().int(), file: z.string().nullable(), stamped: z.number().int(), truncated: z.literal(true).optional() })
    .nullable()
    .optional(),
  events: z
    .looseObject({
      trace_id: z.string(),
      lines: z.number().int(),
      file: z.string().nullable(),
      kinds: z.record(z.string(), z.number().int()),
      stamped: z.number().int(),
      unreadable: z.number().int(),
      unowned: z.number().int(),
      whole: z.boolean(),
      open: z.array(z.looseObject({ gap: z.enum(GAP_WORDS) })),
    })
    .nullable()
    .optional(),
});

const step = z.looseObject({
  line: z.number().int().nullable(),
  text: z.string(),
  step: z.string().nullable(),
  status: z.enum(["passed", "failed", "skipped", "undefined", "ambiguous"]),
  step_record_id: z.string().nullable(),
  record: z.string().nullable(),
  mutates: z.boolean().nullable().optional(),
  observed: observed.optional(),
  record_unreadable: z.literal(true).optional(),
  error: z.looseObject({ kind: errorKind.nullable(), message: z.string() }).optional(),
  used: z.array(z.looseObject({ step: z.string(), record: z.string(), result: z.unknown() })).optional(),
  after_step_end: z.looseObject({ requests: z.number().int(), processes: z.number().int(), http: z.literal("http.jsonl").optional() }).optional(),
  program_log_late: z.looseObject({ lines: z.number().int(), file: z.string().nullable(), truncated: z.literal(true).optional() }).optional(),
  events_late: z.looseObject({ lines: z.number().int(), file: z.string().nullable(), truncated: z.literal(true).optional() }).optional(),
  claims: z.array(z.union([eachClaim, comparisonClaim])).optional(),
  observation: z.enum(["observed", "unobserved"]).optional(),
  attempts: z.number().int().optional(),
});

const declared = z.looseObject({
  attachments: z.array(z.string()).optional(),
  labels: z.array(z.looseObject({ name: z.string(), value: z.string() })).optional(),
  links: z.array(z.looseObject({ url: z.string(), name: z.string().optional(), type: z.string().optional() })).optional(),
  parameters: z.array(z.looseObject({ name: z.string(), value: z.string() })).optional(),
  logs: z.array(z.string()).optional(),
});

// An AfterStep hook names the step it ran after; the other two types
// have no step, and a label would otherwise read `step undefined`.
const hook = z
  .looseObject({
    type: z.enum(["before", "after", "after_step"]),
    status: z.enum(["passed", "failed"]),
    error: z.looseObject({ message: z.string(), kind: errorKind }).optional(),
    declared: declared.optional(),
    step_index: z.number().int().optional(),
    name: z.string().optional(),
    trace: z.string().optional(),
    named_traces: z.array(z.looseObject({ as: z.string(), file: z.string() })).optional(),
    requests_trace: z.string().optional(),
    actions: z.array(z.looseObject({ method: z.string(), ms: z.number(), outcome: z.enum(["passed", "failed"]) })).optional(),
    truncated: z.looseObject({ actions: z.number() }).optional(),
  })
  .refine((entry) => entry.type !== "after_step" || entry.step_index !== undefined, {
    message: "an after_step hook names its step_index",
    path: ["step_index"],
  });

const scenario = z.looseObject({
  scenario_record_id: z.string(),
  feature: z.string(),
  line: z.number().int(),
  scenario: z.string(),
  environment: z.string(),
  status: z.enum(["passed", "failed", "stopped"]),
  stopped: z.looseObject({ after_step: z.number().int().min(1), line: z.number().int().nullable() }).optional(),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  browser: z.looseObject({ type: z.string(), version: z.string() }).optional(),
  steps: z.array(step),
  hooks: z.array(hook),
  evidence: z
    .looseObject({ dir: z.string(), screenshots: z.array(z.looseObject({ file: z.string(), at: z.iso.datetime(), as: z.string().optional() })) })
    .optional(),
  teardown_errors: z.array(z.looseObject({ fixture: z.string(), message: z.string() })).optional(),
  do: z.string().optional(),
  world: z.enum(["base", "old"]).optional(),
  row: z.looseObject({ feature: z.string(), line: z.number().int() }).optional(),
  claims: z
    .looseObject({
      held: z.number().int(),
      broken: z.number().int(),
      unobserved: z.number().int().optional(),
      unjudged: z.number().int().optional(),
    })
    .optional(),
  judged_by: z.enum(["compat", "nothing"]).optional(),
  role: z.enum(["required", "control"]).optional(),
}).refine((entry) => entry.status !== "stopped" || entry.stopped !== undefined, {
  message: "a stopped scenario names the step it was stopped after",
  path: ["stopped"],
});

// The verdict table (src/run/verdict-table.ts), which the summary leads
// with and the Allure results and the messages stream carry per scenario.
const worldName = z.enum(["head", "base", "old"]);

// A fail, broke, or flaky cell is read as `<outcome>@<line>`, so one with
// no line would render as `fail@undefined` rather than be refused.
const tableCell = z
  .looseObject({
    world: worldName,
    environment: z.string(),
    role: z.enum(["required", "control"]),
    conditions: z.record(z.string(), z.union([z.boolean(), z.string(), z.null()])),
    outcome: z.enum(["pass", "fail", "broke", "stopped", "flaky", "not-run"]),
    line: z.number().int().optional(),
    runs: z.number().int(),
    claim: z.number().int().min(0).optional(),
    actuals: z
      .array(z.union([z.looseObject({ value: z.unknown() }), z.looseObject({ json_start: z.string(), json_bytes: z.number().int() }), z.looseObject({ reason: z.string() })]))
      .optional(),
    reason: z.string().optional(),
  })
  .refine((cell) => cell.outcome === "pass" || cell.outcome === "not-run" || cell.line !== undefined, {
    message: "a fail, broke, stopped, or flaky cell names the line it stopped at",
    path: ["line"],
  })
  .refine((cell) => (cell.outcome === "fail" ? cell.claim !== undefined && cell.actuals?.length === cell.runs : cell.claim === undefined && cell.actuals === undefined), {
    message: "a fail cell, and only a fail cell, names the claim that broke and the actual value of each of its runs",
    path: ["claim"],
  });

const table = z.looseObject({
  base: z.looseObject({ ref: z.string(), commit: z.string() }).nullable(),
  mapping_changed: z.boolean().nullable(),
  mapping_changes: z
    .looseObject({ files: z.array(z.string()), config: z.boolean(), conditions: z.array(z.string()), default_environments: z.boolean(), unseen: z.array(z.string()) })
    .nullable(),
  worlds: z.array(z.looseObject({ world: worldName, environment: z.string() })),
  rows: z.array(
    z.looseObject({
      feature: z.string(),
      line: z.number().int(),
      name: z.string(),
      change: z.enum(["unchanged", "changed", "new", "removed"]).nullable(),
      renamed_from: z.looseObject({ feature: z.string(), name: z.string() }).optional(),
      retagged: z.literal(true).optional(),
      conditions: z.array(z.string()),
      cells: z.array(tableCell),
      verdict: z.enum(["held", "proven", "removed", "failed", "unproven", "moved"]),
      reason: z.string(),
      lines: z.array(z.string()).optional(),
    }),
  ),
  left_out: z.number().int(),
  proof_runs: z.number().int().min(1),
});

const document = z.looseObject({
  command: z.literal("run"),
  nukadoko: z.string(),
  // A run id is joined into paths (the run's own records, its exports
  // manifest, and whether it is this project's run), so it has to be the
  // one path segment nuka run generates.
  run_id: z.string().refine((value) => isGeneratedId("run", value), { message: "expected a run id nuka run generates, run-YYYYMMDD-HHMMSS-xxxx" }),
  verdict: z.enum(["passed", "failed"]),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  commit: z.looseObject({ sha: z.string(), dirty: z.boolean() }).nullable(),
  environments: z.array(
    z.looseObject({
      name: z.string(),
      target_version: z.string().nullable(),
      base_url: z.string().nullable().optional(),
      conditions: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
    }),
  ),
  worlds: z
    .array(
      z.looseObject({
        name: z.string(),
        tree: worldName.optional(),
        url: z.string().nullable(),
        program_log: z
          .looseObject({ stamped: z.number().int(), lines: z.number().int(), late: z.number().int(), tagged: z.number().int() })
          .nullable()
          .optional(),
        events: z
          .looseObject({
            file: z.string().nullable(),
            lines: z.number().int(),
            owned: z.number().int(),
            late: z.number().int(),
            unowned: z.number().int(),
            unreadable: z.number().int(),
            undefined_kinds: z.record(z.string(), z.number().int()),
          })
          .nullable()
          .optional(),
      }),
    )
    .optional(),
  selection: z.enum(["full", "partial"]),
  check: z.enum(["ran", "skipped"]).optional(),
  counts: z.looseObject({
    scenarios: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    stopped: z.number().int().optional(),
    controls: z.number().int(),
    not_run: z.number().int(),
    controls_not_run: z.number().int(),
  }),
  scenarios: z.array(scenario),
  table,
  walk: z
    .looseObject({
      pauses: z.array(
        z.looseObject({
          pause: z.number().int().min(1),
          line: z.number().int().nullable(),
          step_record_id: z.string(),
          paused_at: z.iso.datetime(),
          answered_at: z.iso.datetime(),
          answer: z.enum(["next", "stop"]),
          views: z.array(
            z.looseObject({
              as: z.string().nullable(),
              page: z.number().int(),
              url: z.string(),
              title: z.string().nullable(),
              screenshot: z.string().nullable(),
              aria: z.string().nullable(),
            }),
          ),
          http: z.string().optional(),
        }),
      ),
    })
    .optional(),
  findings: z.array(
    z.looseObject({
      severity: z.string(),
      code: z.string(),
      message: z.string(),
      file: z.string().optional(),
      line: z.number().int().optional(),
      step: z.string().optional(),
    }),
  ),
});

/** The run.json text as a document a report can read, or why not. */
export function parseRunDocument(text: string): { readonly document: RunDocument } | { readonly problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problem: `does not parse as JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const version = parsed !== null && typeof parsed === "object" ? (parsed as { schema_version?: unknown }).schema_version : undefined;
  if (version !== ENVELOPE_SCHEMA_VERSION) {
    return { problem: `has schema_version ${JSON.stringify(version ?? null)}, and this release reads ${ENVELOPE_SCHEMA_VERSION}` };
  }
  const result = document.safeParse(parsed);
  if (!result.success) return { problem: `does not have the fields nuka report reads: ${formatValidationIssues(result.error.issues)}` };
  return { document: parsed as RunDocument };
}
