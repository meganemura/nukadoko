import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAllScenarioRecords, selectAcceptableRun } from "../accept/select-run.js";
import { MissingReceiptError, renderAcceptanceRecord, type AcceptedScenario } from "../accept/render-record.js";
import { loadConfig } from "../config/load-config.js";
import { parseFeatureSource } from "../feature/load-features.js";
import { readReceiptsForRecord } from "../report/receipts.js";
import { probeGitState } from "../run/probe-git.js";
import type { ScenarioRecord } from "../run/record-types.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka accept <feature>`'s actual work (m4b-accept task
// spec), kept out of run-cli.ts so it's unit-testable without going through
// yargs (same split as every other command). `accept` never executes
// anything — src/run/run-scenario.ts is untouched by this file — it only
// reads what `nuka run` already wrote (record.json/receipt.json under
// `<stateDir>/scenarios/*`) and, if every one of the spec's seven refusal
// conditions is clear, writes one markdown file beside the feature.
//
// The seven refusal conditions (docs/spec.md's own "refusal conditions" list) are checked in the order
// listed there, each one a `return 1` before anything is written: (1) the
// feature itself doesn't exist or doesn't parse, (2) there is no git
// repository (or no commit yet) to name, (3) the *current* working tree is
// dirty, (4) no run of this feature qualifies — src/accept/select-run.ts's
// own job, three-way distinguished (never run at all / red / partial-only), (5)
// the run that would be frozen recorded no git state of its own, (6) that
// run's own commit no longer matches HEAD, (7) that run's own working tree
// was dirty when it started. Conditions 5-7 read the *selected run's own*
// `git` field, never the current probe from condition 3 — two different
// questions ("is it safe to accept right now" vs "was the run itself
// trustworthy") that only happen to share a probe function
// (src/run/probe-git.ts, reused rather than re-implemented per the spec's
// own list of things this task must not touch).
//
// Feature-path normalization (spec decision on identifying the target run, item 1) is
// applied to *both* sides of the comparison, not just the argument. A
// record's own `feature` is the literal string its `nuka run` invocation was
// given — src/run/select-pickles.ts's `parseFeatureTarget` strips a trailing
// `:<line>` and stores the rest verbatim — so `nuka run
// ./features/x.feature` records `"./features/x.feature"`. Normalizing only
// the argument would leave that run unfindable, and the message it would
// produce is the worst possible one: "no run has ever executed" sends the
// user to run it again, the same way, forever. Passing every record's own
// path through the same function closes that loop here rather than changing
// what `nuka run` stores (which the emitters also read).

export interface RunAcceptOptions {
  rootDir: string;
  featureArg: string;
  stdout: WritableSink;
  stderr: WritableSink;
}

function normalizeFeaturePath(rootDir: string, featureArg: string): string {
  return path.relative(rootDir, path.resolve(rootDir, featureArg));
}

function localDateStamp(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Frontmatter wants `ran_at`/`accepted_at` to read the same day as the
// filename's `localDateStamp` (spec's own settled-decisions section) — a UTC `toISOString()`
// can land on the previous/next local day and make one run look like two.
// Node has no built-in local-offset ISO formatter, so this is hand-rolled:
// `getTimezoneOffset()` returns minutes *west* of UTC (positive west), the
// opposite sign of the offset we print, hence the negation below.
function localIsoWithOffset(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");

  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const offsetMins = String(absOffset % 60).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}.${ms}${sign}${offsetHours}:${offsetMins}`;
}

export async function runAccept(options: RunAcceptOptions): Promise<number> {
  const { rootDir, featureArg, stdout, stderr } = options;
  const featurePath = normalizeFeaturePath(rootDir, featureArg);

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  // --- Refusal condition 1: the feature itself. ---
  const absoluteFeaturePath = path.join(rootDir, featurePath);
  let source: string;
  try {
    source = readFileSync(absoluteFeaturePath, "utf8");
  } catch {
    stderr.write(`nuka accept: feature file not found: ${featurePath}\n`);
    return 1;
  }

  let parsed;
  try {
    parsed = parseFeatureSource(source, featurePath);
  } catch (error) {
    stderr.write(
      `nuka accept: failed to parse feature file "${featurePath}": ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }

  // `?? 0` rather than dropping the pickle: src/run/run-scenario.ts records
  // exactly the same fallback (`pickle.location?.line ?? 0`), and the two
  // sets are compared for equality — a pickle counted here but not there,
  // or the reverse, would read as a partial run and refuse a legitimate
  // sign-off.
  const featureLines = new Set(parsed.pickles.map((pickle) => pickle.location?.line ?? 0));

  // --- Refusal conditions 2-3: the *current* working tree. ---
  const currentGit = await probeGitState(rootDir);
  if (currentGit === undefined) {
    stderr.write(
      "nuka accept: not a git repository (or no commit yet) — a sign-off records a commit, and there is none to record.\n",
    );
    return 1;
  }
  if (!currentGit.clean) {
    stderr.write(
      "nuka accept: the working tree is dirty (untracked files included) — commit or stash first, then run `nuka accept` again.\n",
    );
    return 1;
  }

  // --- Refusal condition 4: is there a run to freeze at all? ---
  const allRecords = loadAllScenarioRecords(rootDir, config.stateDir);
  const featureRecords = allRecords.filter(
    (record: ScenarioRecord) => normalizeFeaturePath(rootDir, record.feature) === featurePath,
  );
  const outcome = selectAcceptableRun(featureRecords, featureLines);

  if (outcome.kind === "none-ever") {
    stderr.write(
      `nuka accept: no run has ever executed ${featurePath} — run \`nuka run ${featurePath}\` first.\n`,
    );
    return 1;
  }
  if (outcome.kind === "red") {
    stderr.write(
      `nuka accept: the most recent full run of ${featurePath} was not all green — fix the failure(s), then \`nuka run ${featurePath}\` again.\n`,
    );
    return 1;
  }
  if (outcome.kind === "partial-only") {
    stderr.write(
      `nuka accept: only partial runs of ${featurePath} exist (e.g. \`nuka run ${featurePath}:<line>\`) — run the whole feature with \`nuka run ${featurePath}\` before accepting.\n`,
    );
    return 1;
  }

  const { group, startedAt } = outcome;
  const anyRecord = group[0]!;

  // --- Refusal conditions 5-7: the *selected run's own* git state. ---
  if (anyRecord.git === undefined) {
    stderr.write(
      `nuka accept: the run being frozen (run_id ${anyRecord.run_id}) recorded no git state — re-run \`nuka run ${featurePath}\` inside a git repository, then accept again.\n`,
    );
    return 1;
  }
  const runGit = anyRecord.git;
  if (runGit.commit !== currentGit.commit) {
    stderr.write(
      `nuka accept: HEAD has moved since that run (run was at ${runGit.commit.slice(0, 7)}, HEAD is now at ${currentGit.commit.slice(0, 7)}) — run \`nuka run ${featurePath}\` again at the current commit, then accept.\n`,
    );
    return 1;
  }
  if (!runGit.clean) {
    stderr.write(
      `nuka accept: that run started on a dirty working tree, so it cannot be frozen as a clean sign-off — commit, then \`nuka run ${featurePath}\` again, then accept.\n`,
    );
    return 1;
  }

  // --- Every condition cleared: build and write the record. ---
  const sortedGroup = [...group].sort((a, b) => a.line - b.line);
  const scenarios: AcceptedScenario[] = sortedGroup.map((record) => ({
    record,
    receipts: readReceiptsForRecord(rootDir, record),
  }));

  let content: string;
  try {
    content = renderAcceptanceRecord({
      featurePath,
      featureSource: source,
      featureName: parsed.gherkinDocument.feature?.name,
      commit: runGit.commit,
      runId: anyRecord.run_id,
      ranAt: localIsoWithOffset(startedAt.toISOString()),
      acceptedAt: localIsoWithOffset(new Date().toISOString()),
      environment: anyRecord.environment,
      targetVersion: anyRecord.target_version,
      scenarios,
    });
  } catch (error) {
    if (error instanceof MissingReceiptError) {
      stderr.write(`nuka accept: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const basename = path.basename(featurePath, ".feature");
  const dateStamp = localDateStamp(startedAt.toISOString());
  const sha7 = runGit.commit.slice(0, 7);
  const outputPath = path.join(path.dirname(absoluteFeaturePath), `${basename}.${dateStamp}-${sha7}.md`);

  await writeFile(outputPath, content);

  stdout.write(`${path.relative(rootDir, outputPath)}\n`);
  return 0;
}
