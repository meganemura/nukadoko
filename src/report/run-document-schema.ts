import { z } from "zod";
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

const errorKind = z.enum(["args_invalid", "result_invalid", "binding_invalid", "world_invalid", "timeout", "unsupported", "step_error"]);

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
  unmeasured: z.array(z.looseObject({ kind: z.enum(["child_process", "worker_thread", "socket", "files"]), detail: z.string() })),
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
  after_step_end: z.looseObject({ requests: z.number().int(), processes: z.number().int() }).optional(),
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
  status: z.enum(["passed", "failed"]),
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
  criteria: z
    .looseObject({
      changed_since: z.enum(["unchanged", "changed", "new", "ambiguous", "unknown"]).nullable(),
      reason: z.string().optional(),
      lines: z.array(z.string()).optional(),
      step_files: z.array(z.string()).optional(),
    })
    .optional(),
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
  environments: z.array(z.looseObject({ name: z.string(), target_version: z.string().nullable(), base_url: z.string().nullable().optional() })),
  selection: z.enum(["full", "partial"]),
  counts: z.looseObject({ scenarios: z.number().int(), passed: z.number().int(), failed: z.number().int(), not_run: z.number().int() }),
  scenarios: z.array(scenario),
  verdicts: z.array(
    z.looseObject({
      feature: z.string(),
      line: z.number().int(),
      scenario: z.string(),
      environment: z.string(),
      verdict: z.enum(["passed", "failed", "not-run"]),
      executions: z.number().int(),
      passed: z.number().int(),
    }),
  ),
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
  since: z
    .looseObject({
      ref: z.string(),
      commit: z.string(),
      compared: z.array(z.string()),
      removed: z.array(z.looseObject({ feature: z.string(), rule: z.string().nullable(), scenario: z.string(), lines: z.array(z.string()) })),
      step_files: z.array(z.looseObject({ file: z.string(), change: z.enum(["unchanged", "changed", "untracked"]) })),
    })
    .nullable()
    .optional(),
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
