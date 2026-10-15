import { readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { formatValidationIssues } from "../issues/format-issues.js";
import type { Vocabulary } from "../discover/discover-steps.js";
import { toStoredForm } from "../stored-form/stored-form.js";
import { isFeatureWithinDir } from "./feature-within-dir.js";
import { discoverMarkdownFiles, normalizeSignoffText, parseAcceptanceRecord } from "./record-parse.js";
import type { TendIssue } from "./types.js";

// Responsibility: docs/spec.md "Tending"'s first, error-level finding — a
// sign-off that no longer matches the code it froze. This is the one
// finding `errors` is ever populated with (src/tend/types.ts's own header): a
// record proves a claim ("this feature was green at this commit, and here
// is the evidence"), and unlike the other five tend findings, a record that
// has quietly stopped being true is worse than no record at all, because it
// is still being counted as proof.
//
// Four ways a record can go stale, all checked here, all `error`:
//   (a) the feature it names no longer exists.
//   (b) the feature source it froze no longer matches the file (exact
//       string comparison after the rewrites `normalizeFeatureSource` names).
//   (c) a step it cites is gone from the current vocabulary. Withheld for
//       the whole run while any step file failed to import: a missing
//       vocabulary entry is not evidence the step was deleted, because
//       the definition may sit in the file that could not be read.
//       Reporting it gone would turn that import failure into an error.
//       The failure itself is the import-failures-unseen note, which does
//       not change the exit code.
//   (d) a step's frozen `result` no longer passes that step's current
//       `returns` schema.
// Checked independently per record, not short-circuited on the first
// failure — a record with a missing feature can still cite a step whose
// contract also changed, and reporting only the first would hide the
// second until the first is fixed and `tend` is run again.
//
// (c)/(d) skip a compat vocabulary entry (`entry.kind !== "typed"`): compat
// has no `returns` schema at all, so "does the frozen result still pass it"
// has no question to ask — the same reason `render-record.ts`'s own
// "Declared vs observed" section keeps a compat step's `mutates: null` out
// of its mismatch count instead of coercing it to "no mismatch". A step
// record whose own `status` isn't `"ok"` is skipped the same way (defensive:
// `nuka accept` only ever freezes a passed scenario, so this should not
// occur in practice).
//
// A fifth way, checked first and independently of (a)-(d): the record
// itself predates the current format (`ParsedAcceptanceRecord.isOldFormat`,
// src/tend/record-parse.ts). Its own step records may still parse, but this
// tool has no way to know whether whatever else changed between that
// version and this one silently changed what "matches" means too, so this
// finding is reported alone and the rest of this record's own checks are
// skipped for it — one clear instruction (re-run and re-accept) rather than
// a stale record and today's vocabulary drift reported as if they were the
// same kind of problem.
//
// Every message here points at how to fix it — re-run and re-accept, or
// revert whatever changed — and never at hand-editing the record itself:
// docs/spec.md is explicit that a hand-edited record just goes back to
// being a claim, which is exactly the failure mode this finding exists to
// catch.
//
// Every check above is skipped for a record whose own frozen feature now
// lives inside `featuresDir` (`isFeatureWithinDir` below, checked
// immediately after a record parses "ok" and before even the old-format
// check). A feature inside `featuresDir` runs unattended on every `nuka
// run` from then on, so the guarantee that feature carries has already
// moved from the frozen record to that run; the record is not proving
// anything a reader still depends on. Reporting its staleness anyway would
// turn every ordinary edit to that feature into an alarm, and an alarm that
// fires on every ordinary edit is one nobody keeps reading. A malformed
// record (`signoff-record-unreadable`, above) is never covered by this
// skip: its own `feature:` value may not even have parsed, so there is no
// placement to judge it by, and "this file looks like a record but cannot
// be read" is a fact about the file, not about whether its claim is still
// current.

const FIX_HINT = "re-run `nuka run` and `nuka accept` to refreeze it, or revert whatever changed since it was accepted";

type Parsed =
  | { success: true; data: unknown }
  | { success: false; error: { issues: readonly z.core.$ZodIssue[] } };

interface SchemaDef {
  type: string;
  shape?: Record<string, WalkableSchema>;
  element?: WalkableSchema;
  innerType?: WalkableSchema;
  options?: readonly WalkableSchema[];
  valueType?: WalkableSchema;
  items?: readonly WalkableSchema[];
  rest?: WalkableSchema | null;
  left?: WalkableSchema;
  right?: WalkableSchema;
  getter?: () => WalkableSchema;
  out?: WalkableSchema;
  catchall?: WalkableSchema;
}

interface WalkableSchema {
  def: SchemaDef;
  safeParse(data: unknown): Parsed;
}

const UNWRAP = new Set(["optional", "nullable", "default", "prefault", "catch", "readonly", "nonoptional"]);

function jsonForm(value: unknown): unknown {
  try {
    return toStoredForm(value);
  } catch {
    return undefined;
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, (b as unknown[])[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    if (aKeys.length !== Object.keys(bObj).length) return false;
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bObj, key) && jsonEqual(aObj[key], bObj[key]));
  }
  return false;
}

function reviveDate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // JSON.stringify writes Date.toJSON(), which is not every string new Date
  // can parse. Only that spelling is the JSON form of a Date.
  return date.toJSON() === value ? date : value;
}

function reviveObject(def: SchemaDef, value: unknown, stack: Set<WalkableSchema>): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const shape = def.shape ?? {};
  const out: Record<string, unknown> = { ...source };
  for (const key of Object.keys(shape)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const child = shape[key];
    if (child !== undefined) out[key] = revive(child, source[key], stack);
  }
  const catchall = def.catchall;
  if (
    catchall !== undefined &&
    catchall.def.type !== "never" &&
    catchall.def.type !== "unknown" &&
    catchall.def.type !== "any"
  ) {
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) out[key] = revive(catchall, source[key], stack);
    }
  }
  return out;
}

function reviveTuple(def: SchemaDef, value: unknown, stack: Set<WalkableSchema>): unknown {
  if (!Array.isArray(value) || def.items === undefined) return value;
  return value.map((item, index) => {
    const itemSchema = def.items?.[index] ?? def.rest;
    return itemSchema == null ? item : revive(itemSchema, item, stack);
  });
}

function reviveRecord(def: SchemaDef, value: unknown, stack: Set<WalkableSchema>): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value) || def.valueType === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = revive(def.valueType, item, stack);
  }
  return out;
}

function reviveUnion(def: SchemaDef, value: unknown, stack: Set<WalkableSchema>): unknown {
  for (const option of def.options ?? []) {
    const candidate = revive(option, value, stack);
    const outcome = option.safeParse(candidate);
    if (!outcome.success) continue;
    const form = jsonForm(outcome.data);
    if (form !== undefined && jsonEqual(form, value)) return candidate;
  }
  return value;
}

function revive(schema: WalkableSchema, value: unknown, stack: Set<WalkableSchema>): unknown {
  if (stack.has(schema)) return value;
  stack.add(schema);
  try {
    const def = schema.def;
    if (UNWRAP.has(def.type) && def.innerType !== undefined) {
      if (value === null || value === undefined) return value;
      return revive(def.innerType, value, stack);
    }
    switch (def.type) {
      case "date":
        return reviveDate(value);
      case "object":
        return reviveObject(def, value, stack);
      case "array":
        if (!Array.isArray(value) || def.element === undefined) return value;
        return value.map((item) => revive(def.element as WalkableSchema, item, stack));
      case "tuple":
        return reviveTuple(def, value, stack);
      case "record":
        return reviveRecord(def, value, stack);
      case "union":
        return reviveUnion(def, value, stack);
      case "intersection":
        if (def.left === undefined || def.right === undefined) return value;
        return revive(def.right, revive(def.left, value, stack), stack);
      case "lazy":
        return def.getter === undefined ? value : revive(def.getter(), value, stack);
      case "pipe":
        return def.out === undefined ? value : revive(def.out, value, stack);
      default:
        return value;
    }
  } finally {
    stack.delete(schema);
  }
}

// The record stores JSON.stringify of the schema output. A Date's JSON
// form is the ISO string from toJSON, which z.date() does not accept as
// input. Accept the frozen result when it is that JSON form of a value
// the schema accepts. An empty object is not that form.
export function assessFrozenResult(
  schema: { safeParse(data: unknown): Parsed },
  frozen: unknown,
): { ok: true } | { ok: false; detail: string } {
  const walkable = schema as WalkableSchema;
  const candidates: unknown[] = [frozen];
  const revived = revive(walkable, frozen, new Set());
  if (!jsonEqual(revived, frozen)) candidates.push(revived);

  let directFailure: string | undefined;
  for (const [index, candidate] of candidates.entries()) {
    const outcome = walkable.safeParse(candidate);
    if (!outcome.success) {
      if (index === 0) directFailure = formatValidationIssues(outcome.error.issues);
      continue;
    }
    const form = jsonForm(outcome.data);
    if (form !== undefined && jsonEqual(form, frozen)) return { ok: true };
  }
  if (directFailure !== undefined) return { ok: false, detail: directFailure };
  return { ok: false, detail: "it is not the JSON form of a value the schema accepts" };
}

// Two rewrites, and they answer different questions. `normalizeSignoffText`
// drops a leading BOM and turns CRLF into LF: a checkout or an editor
// rewrites those bytes, and the frozen source inside the record has
// already been through the same function, so leaving them on the file
// would report a feature change nobody made. The trailing-newline strip is
// the one content normalization. A feature file always ends in its own
// trailing newline, and `render-record.ts` strips exactly one before
// embedding it (its own comment: "the fence's own closing ``` already
// supplies that break"). Applying that same `.replace` to the freshly-read
// file, rather than e.g. `.trim()`ing both sides, is what keeps this
// comparison from forgiving a real difference (leading whitespace, a
// second blank line) that "the fence already supplies a break" was never
// meant to cover.
function normalizeFeatureSource(source: string): string {
  return normalizeSignoffText(source).replace(/\n$/, "");
}

export function findSignoffRot(
  rootDir: string,
  vocabulary: Vocabulary,
  featuresDir: string,
  importFailures: readonly { readonly filePath: string; readonly message: string }[],
): TendIssue[] {
  const issues: TendIssue[] = [];

  for (const absolutePath of discoverMarkdownFiles(rootDir)) {
    const relativePath = path.relative(rootDir, absolutePath);

    let content: string;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue; // Removed between the walk and this read — nothing to report.
    }

    const parsed = parseAcceptanceRecord(content, relativePath);
    if (parsed.kind === "not-a-record") {
      continue; // Ordinary Markdown — the expected case for most `.md` files.
    }
    if (parsed.kind === "malformed") {
      issues.push({
        code: "signoff-record-unreadable",
        message: `${relativePath} looks like an acceptance record (its frontmatter has run_id/commit/feature/scenarios) but could not be read: ${parsed.reason}. A broken record reads as healthy if it is silently skipped, so this is reported instead: ${FIX_HINT}.`,
        file: relativePath,
      });
      continue;
    }

    const record = parsed.record;

    if (isFeatureWithinDir(record.featurePath, featuresDir)) {
      continue; // Runs unattended now; the run carries the guarantee, not this frozen record (this file's own header).
    }

    if (record.isOldFormat) {
      issues.push({
        code: "signoff-record-old-format",
        message: `${relativePath} was written by an older nukadoko: its embedded step records are missing the step_record_id field the current format always writes, so it cannot be checked against the current format. ${FIX_HINT}.`,
        file: relativePath,
      });
      continue;
    }

    // (a) the feature this record freezes.
    let currentFeatureSource: string | undefined;
    try {
      currentFeatureSource = readFileSync(path.join(rootDir, record.featurePath), "utf8");
    } catch {
      issues.push({
        code: "signoff-feature-missing",
        message: `${relativePath} freezes ${record.featurePath}, which no longer exists. The record is still proving a claim about a file that is gone. ${FIX_HINT}.`,
        file: relativePath,
      });
    }

    // (b) frozen source vs. what the file says now — only meaningful once
    // (a) has confirmed the file is still there.
    if (currentFeatureSource !== undefined && normalizeFeatureSource(currentFeatureSource) !== record.featureSource) {
      issues.push({
        code: "signoff-feature-changed",
        message: `${relativePath} froze ${record.featurePath} at a different state than the file has now. The record no longer describes what is on disk. ${FIX_HINT}.`,
        file: relativePath,
      });
    }

    // (c)/(d): every step this record cites, independent of (a)/(b) — a
    // step's own contract can go stale whether or not the feature that
    // exercised it is still intact.
    for (const stepRecord of record.stepRecords) {
      const entry = vocabulary.get(stepRecord.step);
      if (entry === undefined) {
        if (importFailures.length > 0) {
          // Case (c) above: the step may still be defined in a file this
          // run could not read. Calling it gone would make that import
          // failure an error and change the exit code.
          continue;
        }
        issues.push({
          code: "signoff-step-missing",
          message: `${relativePath} cites step "${stepRecord.step}", which is no longer in the vocabulary. The record is still proving a claim about a step that no longer exists. ${FIX_HINT}.`,
          file: relativePath,
          step: stepRecord.step,
        });
        continue;
      }
      if (entry.kind !== "typed") {
        continue; // Compat: no `returns` schema, so no contract to have gone stale.
      }
      if (stepRecord.status !== "ok") {
        continue; // Defensive: `nuka accept` only ever freezes a passed scenario.
      }
      const assessed = assessFrozenResult(entry.step.returns, stepRecord.result);
      if (!assessed.ok) {
        issues.push({
          code: "signoff-result-invalid",
          message: `${relativePath} froze step "${stepRecord.step}"'s result, which no longer passes its current returns schema (${assessed.detail}). The step's contract changed since this record was accepted. ${FIX_HINT}.`,
          file: relativePath,
          step: stepRecord.step,
        });
      }
    }
  }

  return issues;
}
