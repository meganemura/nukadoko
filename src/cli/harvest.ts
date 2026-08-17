import { loadConfig } from "../config/load-config.js";
import { discoverSteps } from "../discover/discover-steps.js";
import { buildDraft } from "../harvest/build-draft.js";
import { readStepRecordById } from "../record/read-step-record.js";
import type { StepRecord } from "../record/types.js";
import { buildStepBindings } from "../run/match-step.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka harvest`'s actual work, kept out of run-cli.ts so
// it's unit-testable without going through yargs (same split as cli/do.ts,
// cli/check.ts). Two phases: setup (config/discovery, then reading every
// given step record id — a missing id or a `kind: "run"` record refuses
// the whole call before anything is printed, docs/spec.md "Harvesting":
// "That record already belongs to a feature") and draft-building
// (src/harvest/build-draft.ts, given every record already read and
// ordered by its own `started_at`).
//
// No time window, no `--since`: the ids are exactly what the caller typed,
// in whatever order — sorted here by `started_at` before anything is
// rendered, so a caller that passed them out of order still gets the
// sequence that actually ran (docs/spec.md "Harvesting": "Which records
// form one sequence is said on the command line, not stored").
//
// The draft goes to stdout only; every id, and every line
// src/harvest/build-draft.ts named as an anomaly, goes to stderr only
// (docs/spec.md "Harvesting": "Provenance goes to stderr and never into
// the file").

export interface RunHarvestOptions {
  rootDir: string;
  stepRecordIds: readonly string[];
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runHarvest(options: RunHarvestOptions): Promise<number> {
  const { rootDir, stepRecordIds, stdout, stderr } = options;

  if (stepRecordIds.length === 0) {
    stderr.write("nuka harvest needs at least one step record id\n");
    return 1;
  }

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  let vocabulary;
  let compatParameterTypes;
  try {
    ({ vocabulary, compatParameterTypes } = await discoverSteps(rootDir, config.featuresDir));
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  // Every id is read and checked before anything is written — a bad id
  // anywhere in the list refuses the whole call, the same "setup failure,
  // nothing printed" shape `nuka do`'s own setup phase already uses. Every
  // problem found is reported, not just the first, since a caller fixing
  // one bad id at a time would otherwise re-run this once per id.
  const setupErrors: string[] = [];
  const recordsById = new Map<string, StepRecord>();
  for (const id of stepRecordIds) {
    const record = readStepRecordById(rootDir, config.stateDir, id);
    if (record === null) {
      setupErrors.push(`no such step record: ${id}`);
      continue;
    }
    if (record.kind === "run") {
      setupErrors.push(
        `step record ${id} belongs to a \`nuka run\` scenario (scenario record ` +
          `${record.scenario_record_id}); harvest that feature directly instead of this step record`,
      );
      continue;
    }
    recordsById.set(id, record);
  }
  if (setupErrors.length > 0) {
    for (const message of setupErrors) {
      stderr.write(`${message}\n`);
    }
    return 1;
  }

  let bindings;
  try {
    bindings = buildStepBindings(vocabulary, config.parameterTypes, compatParameterTypes);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const orderedIds = [...stepRecordIds].sort((a, b) =>
    recordsById.get(a)!.started_at.localeCompare(recordsById.get(b)!.started_at),
  );

  const { featureText, notices } = buildDraft({ orderedIds, recordsById, vocabulary, bindings });

  stdout.write(featureText);
  for (const notice of notices) {
    stderr.write(`${notice}\n`);
  }
  return 0;
}
