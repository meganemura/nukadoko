import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  browserConditionMatches,
  listConditionsWithGreenRun,
  loadAllScenarioRecords,
  selectAcceptableRun,
  type RunCondition,
} from "../accept/select-run.js";
import { MissingStepRecordError, renderAcceptanceRecord, type AcceptedScenario } from "../accept/render-record.js";
import { loadConfig } from "../config/load-config.js";
import { DEFAULT_ENVIRONMENT_NAME, resolveEnvironment, type ResolvedEnvironment } from "../environment/resolve-environment.js";
import { parseFeatureSource } from "../feature/load-features.js";
import { readStepRecordsForScenario } from "../report/step-records.js";
import { listDirtyPaths, probeGitState } from "../run/probe-git.js";
import type { ScenarioRecord } from "../run/record-types.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka accept <feature>`'s actual work, kept out of
// run-cli.ts so it's unit-testable without going through yargs (same split
// as every other command). `accept` never executes
// anything — src/run/run-scenario.ts is untouched by this file — it only
// reads what `nuka run` already wrote (record.json/step record.json under
// `<stateDir>/records/scenarios/*`) and, if every one of the spec's seven refusal
// conditions is clear, writes one markdown file beside the feature and
// prints its own path on stdout — success's own stderr then names the
// choice that follows sign-off (a feature can stay where it is, proving
// only that this change was accepted, or move into `featuresDir` and run
// unattended from then on), never which one to make.
//
// The seven refusal conditions (docs/spec.md's own "refusal conditions" list) are checked in the order
// listed there, each one a `return 1` before anything is written: (1) the
// feature itself doesn't exist or doesn't parse, (2) there is no git
// repository (or no commit yet) to name, (3) the *current* working tree is
// dirty, (4) no run of this feature qualifies — src/accept/select-run.ts's
// own job, four-way distinguished (never run at all / red / partial-only /
// wrong condition), (5)
// the run that would be frozen recorded no git state of its own, (6) that
// run's own commit no longer matches HEAD, (7) that run's own working tree
// was dirty when it started. Conditions 5-7 read the *selected run's own*
// `git` field, never the current probe from condition 3 — two different
// questions ("is it safe to accept right now" vs "was the run itself
// trustworthy") that only happen to share a probe function
// (src/run/probe-git.ts, reused rather than re-implemented per the spec's
// own list of things this task must not touch).
//
// Condition 4's fourth way: a candidate must have run under the *current*
// condition, both axes — `environment` (this command's own `--env`,
// resolved through `resolveEnvironment`, the exact same path `nuka run`
// uses, no separate default of its own) matched against each record's own
// measured `environment` field, and `config.browserType` matched against
// each record's own measured `browser.type` (never a declaration stored on
// the record: a declared browser type and the one actually launched can
// diverge, e.g. a step overriding the `page` fixture with a different
// engine, so only the measured value is worth recording or comparing
// against) via `browserConditionMatches`. Filenames already carry
// the condition (below), so a candidate selected under the wrong
// environment would freeze a record whose own name lies about what it was
// confirmed under — `--env` closes that gap: without it, two green runs of
// the same feature under different environments could only ever be
// resolved by accepting whichever is newer, never by naming the one that
// is wanted. When the (environment, browser)-filtered selection isn't
// "ok", `featureRecords` (unfiltered) is checked once more before falling
// back to the three condition-blind refusals: if a green full run exists
// *somewhere*, just not under this condition, that is a materially
// different situation ("run again under this condition, or point `--env`/
// `browserType` at one that already has one") from "nothing has ever run"
// — see the "no run under the current condition" branch below.
//
// Feature-path normalization is applied to *both* sides of the
// comparison, not just the argument. A
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
  /** `--env`, resolved the exact same way `nuka run`'s is (`null` means the
   * flag was omitted, resolving to `DEFAULT_ENVIRONMENT_NAME` without
   * requiring a matching `environments` entry — see resolve-environment.ts's
   * own header). */
  env: string | null;
  stdout: WritableSink;
  stderr: WritableSink;
}

function normalizeFeaturePath(rootDir: string, featureArg: string): string {
  return path.relative(rootDir, path.resolve(rootDir, featureArg));
}

// The number of failed scenarios named in a "red" refusal is capped
// (truncation is fine, silent truncation is not) so one feature with
// dozens of scenarios can't turn the refusal into a wall of text; the
// "(+N more)" tail is what keeps the cap from reading as the whole story.
const MAX_FAILED_SCENARIOS_NAMED = 5;

// git-state refusals just above already name what they read (run_id,
// commit); this brings "red"/"partial-only" in line with that, rather
// than leaving them the only refusals in this file that don't.
function formatFailedScenarios(group: readonly ScenarioRecord[]): string {
  const failed = group.filter((record) => record.status !== "passed").sort((a, b) => a.line - b.line);
  const shown = failed.slice(0, MAX_FAILED_SCENARIOS_NAMED);
  const parts = shown.map((record) => `${record.scenario} (line ${record.line}) failed`);
  const omitted = failed.length - shown.length;
  if (omitted > 0) {
    parts.push(`(+${omitted} more)`);
  }
  return parts.join("; ");
}

// Names the alternatives a "wrong condition" refusal enumerates.
// `browserType: undefined` reads as "no browser launched" rather than an
// empty string, matching how the record body and the filename itself both
// say the same thing explicitly rather than leaving a blank: an empty
// value would leave "no browser launched" indistinguishable from "forgot
// to record it".
function formatCondition(condition: RunCondition): string {
  return condition.browserType === undefined
    ? `environment ${condition.environment} (no browser launched)`
    : `environment ${condition.environment}, browser ${condition.browserType}`;
}

// Whether a dirty path measured by `listDirtyPaths` sits under the state
// directory. `stateDir` is a rootDir-relative string (config/schema.ts's
// own default: ".nukadoko");
// `dirtyPath` is already rootDir-relative and forward-slash-separated
// (probe-git.ts's own rebasing), so both sides are normalized to the same
// separator before comparing.
function isUnderStateDir(dirtyPath: string, stateDir: string): boolean {
  const normalizedStateDir = stateDir.split(path.sep).join("/").replace(/\/+$/, "");
  return dirtyPath === normalizedStateDir || dirtyPath.startsWith(`${normalizedStateDir}/`);
}

// Refusal condition 3's own message, widened to say *what* is dirty when
// that closes a loop this can otherwise fall into (dirty -> commit/stash
// -> accept -> HEAD moved -> run -> dirty again, because the thing making
// the tree dirty was nukadoko's own state directory the whole time). Only
// ever reports what was measured, never a
// verdict: the project may be gitignoring the state directory correctly and
// dirty for an unrelated reason (no mention here, the base message alone
// answers that), or may be tracking it on purpose (this function does not
// say that is wrong, only that `nuka init` gitignores it and why).
function formatDirtyTreeRefusal(dirtyPaths: readonly string[], stateDir: string): string {
  const base = "nuka accept: the working tree is dirty (untracked files included).";
  const cta = "Commit or stash first, then run `nuka accept` again.";

  const underState = dirtyPaths.filter((dirtyPath) => isUnderStateDir(dirtyPath, stateDir));
  if (underState.length === 0) {
    return `${base} ${cta}`;
  }

  const scopeSentence =
    underState.length === dirtyPaths.length
      ? `nuka accept: the working tree is dirty, entirely under the state directory (${stateDir}/).`
      : `nuka accept: the working tree is dirty, including paths under the state directory (${stateDir}/).`;

  return (
    `${scopeSentence} That is where nukadoko writes on every \`nuka run\` (step records, scenario records). ` +
    `\`nuka init\` gitignores it for that reason, so this project's .gitignore may be missing that entry, ` +
    `or ${stateDir}/ may be tracked on purpose. ${cta}`
  );
}

function localDateStamp(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Frontmatter wants `ran_at`/`accepted_at` to read the same day as the
// filename's `localDateStamp` — a UTC `toISOString()` can land on the
// previous/next local day and make one run look like two.
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
  const { rootDir, featureArg, env, stdout, stderr } = options;
  const featurePath = normalizeFeaturePath(rootDir, featureArg);

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  // Same path `nuka run` resolves `--env` through (this file's own header)
  // — an unknown explicit name is a setup failure here too, before any of
  // the seven refusal conditions below are even checked.
  let resolvedEnv: ResolvedEnvironment;
  try {
    resolvedEnv = resolveEnvironment(config, env ?? DEFAULT_ENVIRONMENT_NAME, env !== null);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
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
      "nuka accept: not a git repository (or no commit yet). A sign-off records a commit, and there is none to record.\n",
    );
    return 1;
  }
  if (!currentGit.clean) {
    const dirtyPaths = await listDirtyPaths(rootDir);
    stderr.write(`${formatDirtyTreeRefusal(dirtyPaths, config.stateDir)}\n`);
    return 1;
  }

  // --- Refusal condition 4: is there a run to freeze, under the current
  // condition? ---
  const allRecords = loadAllScenarioRecords(rootDir, config.stateDir);
  const featureRecords = allRecords.filter(
    (record: ScenarioRecord) => normalizeFeaturePath(rootDir, record.feature) === featurePath,
  );
  // "Measured vs measured": every candidate must match on both axes —
  // `environment` against each record's own measured `environment` field,
  // and browser: either the record launched none at all, or it launched
  // the one the *current* config declares (never a value stored on the
  // record itself).
  const conditionRecords = featureRecords.filter(
    (record) => record.environment === resolvedEnv.name && browserConditionMatches(record, config.browserType),
  );
  const outcome = selectAcceptableRun(conditionRecords, featureLines);

  if (outcome.kind !== "ok") {
    // The current condition has no qualifying run. Before falling back to
    // the three condition-blind refusals below, check whether a green
    // full run exists at all, just under some other condition — a
    // materially different situation from "nothing has ever run".
    const anyConditionOutcome = selectAcceptableRun(featureRecords, featureLines);

    if (anyConditionOutcome.kind === "ok") {
      const otherConditions = [...listConditionsWithGreenRun(featureRecords, featureLines)].sort(
        (a, b) => a.environment.localeCompare(b.environment) || (a.browserType ?? "").localeCompare(b.browserType ?? ""),
      );
      stderr.write(
        `nuka accept: no green full run of ${featurePath} exists under the current condition (environment: ${resolvedEnv.name}, browser: ${config.browserType}). ` +
          `Runs exist for: ${otherConditions.map(formatCondition).join("; ")}. ` +
          `Run \`nuka run ${featurePath}\` under this condition, or point --env/browserType at one of those, then accept again.\n`,
      );
      return 1;
    }
    if (anyConditionOutcome.kind === "none-ever") {
      stderr.write(
        `nuka accept: no run has ever executed ${featurePath}. Run \`nuka run ${featurePath}\` first.\n`,
      );
      return 1;
    }
    if (anyConditionOutcome.kind === "red") {
      const runId = anyConditionOutcome.group[0]!.run_id;
      stderr.write(
        `nuka accept: the most recent full run of ${featurePath} (run_id ${runId}, started ${anyConditionOutcome.startedAt.toISOString()}) was not all green: ${formatFailedScenarios(anyConditionOutcome.group)}. Fix the failure(s), then \`nuka run ${featurePath}\` again.\n`,
      );
      return 1;
    }
    // anyConditionOutcome.kind === "partial-only". Every record in this
    // group shares the run that produced it, so its own `line` set is
    // exactly the scenario(s) that run touched — usually one, since `:line`
    // is `selectPickles`'s only way to produce a partial group at all
    // (src/run/select-pickles.ts).
    const touchedLines = [...new Set(anyConditionOutcome.group.map((record) => record.line))].sort((a, b) => a - b);
    const lineWord = touchedLines.length === 1 ? "line" : "lines";
    stderr.write(
      `nuka accept: only partial runs of ${featurePath} exist (most recent covered ${lineWord} ${touchedLines.join(", ")} of ${featureLines.size} scenarios, started ${anyConditionOutcome.startedAt.toISOString()}). Run the whole feature with \`nuka run ${featurePath}\` before accepting.\n`,
    );
    return 1;
  }

  const { group, startedAt } = outcome;
  const anyRecord = group[0]!;
  // The group's own recorded browser condition — every record in `group`
  // already satisfies `browserConditionMatches`, so any one that launched
  // a browser at all measured the same `config.browserType` this run was
  // filtered against; `undefined` when none of them did.
  const browserRecord = group.find((record) => record.browser !== undefined)?.browser;

  // --- Refusal conditions 5-7: the *selected run's own* git state. ---
  if (anyRecord.git === undefined) {
    stderr.write(
      `nuka accept: the run being frozen (run_id ${anyRecord.run_id}) recorded no git state. Re-run \`nuka run ${featurePath}\` inside a git repository, then accept again.\n`,
    );
    return 1;
  }
  const runGit = anyRecord.git;
  if (runGit.commit !== currentGit.commit) {
    stderr.write(
      `nuka accept: HEAD has moved since that run (run was at ${runGit.commit.slice(0, 7)}, HEAD is now at ${currentGit.commit.slice(0, 7)}). Run \`nuka run ${featurePath}\` again at the current commit, then accept.\n`,
    );
    return 1;
  }
  if (!runGit.clean) {
    stderr.write(
      `nuka accept: that run started on a dirty working tree, so it cannot be frozen as a clean sign-off. Commit, then \`nuka run ${featurePath}\` again, then accept.\n`,
    );
    return 1;
  }

  // --- Every condition cleared: build and write the record. ---
  const sortedGroup = [...group].sort((a, b) => a.line - b.line);
  const scenarios: AcceptedScenario[] = sortedGroup.map((record) => ({
    record,
    stepRecords: readStepRecordsForScenario(rootDir, record),
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
      browser: browserRecord,
      scenarios,
    });
  } catch (error) {
    if (error instanceof MissingStepRecordError) {
      stderr.write(`nuka accept: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // The filename bakes the condition in — a different condition must
  // never collide with, and silently overwrite, another one's own record.
  // `<date>-<sha>` stays exactly where it was so an existing reader
  // looking for that substring still finds it; `environment` and the
  // browser segment are appended after. The browser segment is the literal
  // `no-browser` when nothing in `group` launched one, never an omitted
  // segment — an omitted segment would make "browser not part of this
  // filename" indistinguishable from "happened not to need one this time"
  // at a glance, and never a version (the engine's type is enough for
  // acceptance; the version lives in the record body).
  const basename = path.basename(featurePath, ".feature");
  const dateStamp = localDateStamp(startedAt.toISOString());
  const sha7 = runGit.commit.slice(0, 7);
  const browserSegment = browserRecord === undefined ? "no-browser" : browserRecord.type;
  const outputPath = path.join(
    path.dirname(absoluteFeaturePath),
    `${basename}.${dateStamp}-${sha7}.${anyRecord.environment}.${browserSegment}.md`,
  );

  await writeFile(outputPath, content);

  const relativeOutputPath = path.relative(rootDir, outputPath);
  stdout.write(`${relativeOutputPath}\n`);
  // Guidance, not a verdict: this command has no way to know whether
  // featurePath is about the change that produced it or the product's own
  // path, so it names the question and both homes rather than choosing one
  // (docs/spec.md's own "the tool measures what it can measure and trusts a
  // declaration for what it cannot" — this is exactly a thing it cannot
  // measure). stdout above stays exactly the record's own path, unchanged,
  // for whatever reads it as a machine-readable result; this goes to
  // stderr, the same channel `nuka run`'s own progress output already uses
  // for something a human reads alongside a machine-readable stdout.
  stderr.write(
    `nuka accept: wrote ${relativeOutputPath} for ${featurePath}.\n` +
      "Does this describe the change, or the product's own path?\n" +
      "Left where it is, this record only proves acceptance.\n" +
      `Moved into ${config.featuresDir}/, together with the feature, it runs unattended on every future \`nuka run\`.\n`,
  );
  return 0;
}
