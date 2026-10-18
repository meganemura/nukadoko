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
// wrong. Fields no report reads are not checked: a later release may add
// fields, and an added field does not move the version.

const step = z.looseObject({
  text: z.string(),
  status: z.string(),
  step_record_id: z.string().nullable(),
  record: z.string().nullable(),
  error: z.looseObject({ message: z.string() }).optional(),
});

const hook = z.looseObject({
  type: z.enum(["before", "after", "after_step"]),
  status: z.enum(["passed", "failed"]),
});

const scenario = z.looseObject({
  scenario_record_id: z.string(),
  feature: z.string(),
  line: z.number().int(),
  scenario: z.string(),
  environment: z.string(),
  status: z.enum(["passed", "failed"]),
  started_at: z.string(),
  finished_at: z.string(),
  steps: z.array(step),
  hooks: z.array(hook),
  evidence: z.looseObject({ dir: z.string(), screenshots: z.array(z.looseObject({ file: z.string() })) }).optional(),
});

const document = z.looseObject({
  command: z.literal("run"),
  nukadoko: z.string(),
  // A run id is joined into paths (the run's own records, its exports
  // manifest, and whether it is this project's run), so it has to be the
  // one path segment nuka run generates.
  run_id: z.string().refine((value) => isGeneratedId("run", value), { message: "expected a run id nuka run generates, run-YYYYMMDD-HHMMSS-xxxx" }),
  verdict: z.enum(["passed", "failed"]),
  started_at: z.string(),
  finished_at: z.string(),
  commit: z.looseObject({ sha: z.string(), dirty: z.boolean() }).nullable(),
  environments: z.array(z.looseObject({ name: z.string(), target_version: z.string().nullable() })),
  selection: z.enum(["full", "partial"]),
  counts: z.looseObject({ scenarios: z.number(), passed: z.number(), failed: z.number() }),
  scenarios: z.array(scenario),
  verdicts: z.array(z.looseObject({ feature: z.string(), line: z.number(), environment: z.string(), verdict: z.string() })),
  findings: z.array(z.looseObject({ severity: z.string(), code: z.string(), message: z.string() })),
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
