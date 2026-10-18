import { versioned } from "../record/schema-version.js";
import yargs from "yargs";
// TODO(types): @types/yargs is pinned to the 17.x line (no 18.x types on
// DefinitelyTyped yet); CommandModule/Argv here
// are the 17.x shapes. yargs 18's runtime behavior used below (command
// builders, .fail(), parseAsync()) is unchanged from 17, so this is a type
// approximation, not a behavior mismatch.
import type { Arguments, Argv, CommandModule } from "yargs";
import { readOwnVersion } from "../version.js";
import { AGENT_ENTRY_POINT, HELP_WIDTH, type HelpGroup, helpLines, renderCommandGroups, withoutFlatListing } from "./help-groups.js";
import {
  commandTookTheName,
  DEFAULT_EXPLORE_LENGTH,
  DEFAULT_EXPLORE_RUNS,
  VALID_STEP_NAME,
} from "./option-defaults.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { shellWord } from "../shell/shell-word.js";
import { RefusalError, commandPathOf, helpFor, refuse } from "./refusal.js";

// Responsibility: wires the commands (`steps`, `describe`, `do`, `run`,
// `session list`/`clear`, `init`, `scaffold`, `check`,
// `clean`, `tend`, `skill path`, `experimental explore`)
// to yargs and turns any failure — yargs' own (bad flags, no command) or
// ours (config/discovery errors, unknown step name) — into stderr output
// plus a non-zero exit code, without ever calling `process.exit` itself.
// That is `cli.ts`'s job, so this function stays callable directly from
// tests. `do`'s own setup/execution split and step record writing lives in
// cli/do.ts; `run`'s own execution lives in cli/run.ts;
// `session`'s own list/clear logic lives in
// cli/session.ts; `init`/`scaffold`'s own generation logic lives in
// cli/init.ts and
// cli/scaffold.ts; `check`'s own analysis lives in cli/check.ts (thin
// wiring) and src/check/* (the actual checks); `clean`'s own plan-then-
// delete logic lives entirely in cli/clean.ts (see that file's own header
// for why it stays self-contained rather than sharing path helpers with
// cli/do.ts/cli/run.ts); `tend`'s own analysis lives
// in cli/tend.ts (thin wiring) and src/tend/* (the actual findings) — the
// same split, one command answering "can this run", the other "is this
// still healthy" (docs/spec.md "Tending"); `skill`'s own path resolution logic lives in cli/skill.ts
// (`install` removed — see that file's header), the same split;
// this module only wires their argv shapes and reports their
// exit codes.
//
// `--version` reads nukadoko's own package.json via
// src/version.ts's readOwnVersion() and is fed to yargs' `.version()`
// explicitly, below — yargs was never told a version before, so it fell
// back to its own default resolution, which walks up from `process.cwd()`
// and prints whichever project happens to be running the CLI, not
// nukadoko's own. If reading nukadoko's own version fails, that is a
// packaging bug (see readOwnVersion()'s own doc comment): the whole
// invocation fails fast, before yargs even parses `argv`, rather than
// falling through to a wrong or guessed version string.
//
// Each handler loads its own command's module with `import()` when it runs,
// while every option table stays static here: yargs needs the tables to
// parse and to print `--help`, and nothing else. A static import of every
// command made `nuka --version` load the run engine, the report emitters,
// the compat layer, and zod before it printed one line, and every command
// paid for every other command's modules. tests/cli-lazy-load.test.ts holds
// `--help` and `--version` to that.

export type { WritableSink } from "../sink/writable-sink.js";

export interface RunCliOptions {
  rootDir?: string;
  stdout?: WritableSink;
  stderr?: WritableSink;
}

interface StepsArgs {
  json?: boolean;
}

interface DescribeArgs {
  name: string;
}

interface DoArgs {
  name: string;
  /** Optional only when `--use` is also given — `doCommand`'s own
   * `.check()` below enforces that at least one of the two is present; the
   * handler defaults a missing `args` to `"{}"` so `--use`'s `from`
   * injection (do.ts, execution phase) still has an object to fill. */
  args?: string;
  session?: string;
  env?: string;
  /** `--use <record-id>` (repeatable) — yargs' `array: true` collects
   * every occurrence into this list, in the order given, rather than only
   * keeping the last one. */
  use?: string[];
}

interface RunArgs {
  feature?: string[];
  /** `false` under `--no-check` (yargs' own boolean negation). */
  check?: boolean;
  env?: string;
  /** Suppresses the per-step/per-scenario progress lines — the
   * output-location and summary lines still print; run.ts's own header
   * explains why those two are exempt. */
  quiet?: boolean;
  /** Writes the scenario records to stdout; without it stdout stays empty. */
  records?: boolean;
  /** Prints run.json on stdout instead of the scenario record stream. */
  json?: boolean;
  /** Same `NaN`/fraction caveat as `concurrency` below; run.ts refuses
   * anything but a whole number of 1 or more. */
  repeat?: number;
  /** yargs' own `type: "number"` accepts `NaN`/a fraction without
   * complaint; run.ts's own setup phase is what actually refuses either
   * (that file's own header explains why the check lives there and not
   * here). */
  concurrency?: number;
  /** `--summary <path>`: one more copy of the Markdown run summary. */
  summary?: string;
}

interface ExploreArgs {
  file: string;
  /** yargs' `type: "number"` passes `NaN` or a fraction through; explore.ts
   * refuses both. */
  seed?: number;
  runs?: number;
  length?: number;
  env?: string;
  json?: boolean;
}

interface SessionListArgs {
  json?: boolean;
}

interface SessionClearArgs {
  name?: string;
  env?: string;
}

interface InitArgs {
  allure?: boolean;
  server?: string;
  serverUrl?: string;
}

interface ScaffoldArgs {
  /** Absent only with `--feature`, which names each stub itself. */
  name?: string;
  feature?: string;
  pattern?: string;
  then?: boolean;
  /** `""` when the flag is given with no value, and `false` for yargs'
   * own `--no-command`, which means the flag is absent. */
  command?: string | false;
  description?: string;
  from?: string[];
  cwd?: string;
  argv?: string;
  request?: string;
  body?: string;
  replace?: boolean;
}

interface CheckArgs {
  json?: boolean;
  codes?: boolean;
  feature?: string[];
}

interface TendArgs {
  json?: boolean;
  codes?: boolean;
  /** `--fail-on`; yargs collects a repeated flag into an array. */
  "fail-on"?: string[];
}

interface CleanArgs {
  dryRun?: boolean;
  json?: boolean;
}

type SkillPathArgs = Record<string, never>;

/** Why `--feature` cannot go with the other scaffold options, or `null`.
 * Each undefined line decides its own name, pattern, and outcome, so a
 * value given once would apply to every stub at once. */
function featureScaffoldConflict(args: ScaffoldArgs): string | null {
  const given = [
    args.name !== undefined ? "a step name" : null,
    args.pattern !== undefined ? "--pattern" : null,
    args.then === true ? "--then" : null,
    typeof args.command === "string" ? "--command" : null,
    args.description !== undefined ? "--description" : null,
    (args.from ?? []).length > 0 ? "--from" : null,
    args.cwd !== undefined ? "--cwd" : null,
    args.argv !== undefined ? "--argv" : null,
    args.request !== undefined ? "--request" : null,
    args.body !== undefined ? "--body" : null,
    args.replace === true ? "--replace" : null,
  ].filter((option): option is string => option !== null);
  if (given.length === 0) return null;
  return `--feature names each stub and reads its pattern and outcome from its own line; leave out ${given.join(", ")}, or scaffold that step on its own with nuka scaffold <name>`;
}

// yargs-parser collects a repeated string or number flag into an array.
// `duplicate-arguments-array: false` would keep the last value, but the
// switch is parser-wide and would also collapse `--use` and `--fail-on`,
// which are arrays on purpose. A per-option `coerce` that throws runs
// before a nested command's positional is bound, and yargs then also
// reports that positional as missing and as an unknown argument. This
// check runs once the argv object exists, so the refusal names the flag
// and nothing else. The parser does not collect a repeated boolean, so
// booleans are not listed here.
function rejectRepeatedFlags(flags: readonly string[]) {
  return (args: Arguments) => {
    const record = args as unknown as Record<string, unknown>;
    for (const flag of flags) {
      const key = flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      const value = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : record[flag];
      if (Array.isArray(value)) {
        throw new Error(`--${flag} was given more than once.`);
      }
    }
    return true;
  };
}

const INIT_WRITES_ENV_LINES = "init always adds .env, .env.*, and !.env.example to .gitignore.";
const CLEAN_REMOVES_EVERY_CATEGORY =
  "nuka clean always removes records, cache, and export together; nuka clean --dry-run lists what it would remove.";

// A removed flag is refused by name, with what replaces it, rather than
// left to `.strict()`: "Unknown argument: session" says what is wrong with
// an older command but not what to write instead. Hidden, so --help lists
// only what works.
function refuseRemovedFlags(y: Argv, removed: Readonly<Record<string, string>>): Argv {
  const withOptions = Object.keys(removed).reduce((acc, flag) => acc.option(flag, { hidden: true }), y);
  return withOptions.check((args) => {
    const record = args as unknown as Record<string, unknown>;
    for (const [flag, message] of Object.entries(removed)) {
      if (record[flag] !== undefined) throw new Error(message);
    }
    return true;
  });
}

function firstWord(command: string | readonly string[] | undefined): string {
  const text = typeof command === "string" ? command : (command?.[0] ?? "");
  return text.split(" ")[0] ?? "";
}

/** The invocation that reached the moved `explore` spelling, with `explore`
 * replaced by `experimental explore` and every other word kept. */
export function movedExploreCommandLine(argv: readonly string[]): string {
  const at = argv.indexOf("explore");
  const words = [...argv.slice(0, at), "experimental", "explore", ...argv.slice(at + 1)];
  return ["nuka", ...words.map(shellWord)].join(" ");
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const rootDir = options.rootDir ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  // Only a command that runs project code takes the process stdout over:
  // yargs prints help and the version through console.log. An injected
  // sink is not the process stream, so there is nothing to protect.
  const recordStdout = async (): Promise<WritableSink> =>
    options.stdout ?? (await import("../run/step-stdout.js")).divertProcessStdoutToStderr();

  let ownVersion: string;
  try {
    ownVersion = readOwnVersion();
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let exitCode = 0;

  // yargs 18's `.strict()` reports an unknown flag/command by invoking
  // `.fail()` below, but — known yargs behavior, not a bug we can configure
  // away — it then runs the matched command's handler anyway (validation and
  // dispatch are separate steps in yargs' internals; a custom `.fail()`
  // callback that doesn't throw just falls through to dispatch). Every
  // handler here overwrites the shared `exitCode` with its own result and
  // may perform real side effects (writing a step record, clearing a session),
  // so letting it run would silence the failure and let an unparsed
  // invocation take real action. `argsFailed` is set synchronously inside
  // `.fail()`, which — because validation always runs before dispatch, see
  // yargs' `handleValidationAndGetResult` — is guaranteed to be set before
  // any handler below reads it. Each handler checks it first and returns
  // immediately, before doing anything else, so a failed parse has zero
  // side effects.
  let argsFailed = false;
  const usageFailures: string[] = [];
  // The `do` a `.check()` names for its own refusal, kept only when that
  // refusal is the parse's one failure: with two, neither one's fix is the
  // whole fix, and the command's help covers both.
  const usageFailureDos: (string | undefined)[] = [];

  // Wraps a command that reads the config, so a directory without one is
  // named on stderr. In the handler rather than a yargs middleware: global
  // middleware runs before a command's own `.check()`, so a refused flag
  // would print this line ahead of its error. `init` writes the config and
  // `scaffold` names the case itself or refuses, so neither is wrapped.
  const namingMissingConfig = <T, U>(command: CommandModule<T, U>): CommandModule<T, U> => ({
    ...command,
    handler: async (args) => {
      if (!argsFailed) {
        const { locateConfig, noConfigLine } = await import("../config/config-presence.js");
        const line = noConfigLine(rootDir, locateConfig(rootDir));
        if (line !== null) stderr.write(`${line}\n`);
      }
      await command.handler(args);
    },
  });

  const stepsCommand: CommandModule<Record<string, never>, StepsArgs> = {
    command: "steps",
    describe: "list the whole vocabulary, typed and compat: name, patterns, description, mutates",
    builder: (y: Argv) =>
      y.option("json", {
        type: "boolean",
        default: false,
        describe: "machine-readable output",
      }) as Argv<StepsArgs>,
    handler: async (args: Arguments<StepsArgs>) => {
      if (argsFailed) return;
      const [
        { buildFixtureGraph },
        {
          assertFeaturesDirExists,
          buildStepNames,
          formatImportFailuresStderr,
          formatVocabulary,
          loadVocabulary,
          summarize,
          toImportFailureSummaries,
        },
      ] = await Promise.all([
        import("../fixture/graph.js"),
        import("./vocabulary.js"),
      ]);
      try {
        // Tolerant: `steps` is a reporting tool, not something about to
        // execute a step, so one broken glue file elsewhere must not empty
        // everything else it could still read — the same migrating-suite
        // reasoning `nuka check`/`nuka tend` already act on. `run`/`do`/
        // `init` deliberately do not pass this (they stay fail-fast).
        const { vocabulary, config, importFailures } = await loadVocabulary(rootDir, {
          tolerateImportFailures: true,
        });
        // `nuka check`'s own `features-dir-missing` condition: discovery
        // itself treats a missing featuresDir as an empty vocabulary, so
        // this call is what keeps that leniency from reading, on stdout, as
        // indistinguishable from a real project that simply has no steps
        // yet. Thrown before
        // any stdout.write below, so a failure here never leaves a partial
        // or misleading `--json` payload behind.
        assertFeaturesDirExists(rootDir, config);
        const stepNames = buildStepNames(vocabulary);
        const graph = buildFixtureGraph(config);
        const summaries = [...vocabulary.values()].map((entry) => summarize(entry, stepNames, rootDir, graph));
        const importFailureSummaries = toImportFailureSummaries(importFailures);
        if (args.json) {
          // Top-level shape change from a bare array to `{ steps,
          // import_failures }` — 0.x accepts the break; the alternative,
          // silently dropping `import_failures` off a bare array, is
          // exactly the "machine reader treats an incomplete list as
          // complete" failure this field exists to prevent.
          stdout.write(
            `${JSON.stringify(versioned("steps", { steps: summaries, import_failures: importFailureSummaries }), null, 2)}\n`,
          );
        } else {
          // `stdout` here is the injected `WritableSink` (real process
          // stdout by default, a capture sink in tests), which has no
          // notion of terminal width; `process.stdout.columns` is read
          // directly instead, falling back to 80 for a non-TTY or a test
          // run.
          stdout.write(formatVocabulary(summaries, process.stdout.columns ?? 80));
        }
        stderr.write(formatImportFailuresStderr(rootDir, importFailureSummaries));
        // Exit 1 whenever the output is incomplete in a way this command
        // still went ahead and printed anyway — the check below has to name
        // every such case, not just today's, so a new one has to be added
        // here the moment it exists. So far: an import failure, a step
        // whose own `needs` this run couldn't read (`summarize`'s own
        // `needs_error`), and a step with an unreadable `from` entry
        // (`from_errors`).
        // Output is not withheld either way — only "this succeeded" is.
        if (
          importFailures.length > 0 ||
          summaries.some((s) => s.needs_error !== undefined || s.from_errors !== undefined)
        ) {
          exitCode = 1;
        }
      } catch (error) {
        exitCode = refuse({ json: args.json ?? false, stdout, stderr }, error, helpFor("steps"));
      }
    },
  };

  const describeCommand: CommandModule<Record<string, never>, DescribeArgs> = {
    command: "describe <name>",
    describe: "full contract, schemas as JSON Schema",
    builder: (y: Argv) =>
      y.positional("name", {
        type: "string",
        demandOption: true,
        describe: "step name (as listed by `nuka steps`)",
      }) as Argv<DescribeArgs>,
    handler: async (args: Arguments<DescribeArgs>) => {
      if (argsFailed) return;
      const [
        { buildFixtureGraph },
        {
          assertFeaturesDirExists,
          buildStepNames,
          describeContract,
          formatImportFailuresStderr,
          loadVocabulary,
          toImportFailureSummaries,
        },
      ] = await Promise.all([
        import("../fixture/graph.js"),
        import("./vocabulary.js"),
      ]);
      // `describe` has no text form: its stdout is always one JSON object,
      // so a refusal is one too.
      const sinks = { json: true, stdout, stderr };
      const help = helpFor("describe");
      try {
        // Same tolerant mode as `steps` above, same reasoning — also the
        // one case where it matters most: the step this call is asking
        // about may be exactly the one whose own file failed to import, so
        // "Unknown step" alone would misdiagnose a migration problem as a
        // typo.
        const { vocabulary, config, importFailures } = await loadVocabulary(rootDir, {
          tolerateImportFailures: true,
        });
        // Discovery treats a missing featuresDir as an empty vocabulary, so
        // the lookup below would report "Unknown step" for a directory that
        // is not there. Same refusal `steps` makes above, and it has to
        // happen before any stdout write.
        assertFeaturesDirExists(rootDir, config);
        const importFailureSummaries = toImportFailureSummaries(importFailures);
        const entry = vocabulary.get(args.name);
        if (!entry) {
          exitCode = refuse(sinks, new RefusalError(`Unknown step: ${args.name}`, "nuka steps"), help);
          stderr.write(formatImportFailuresStderr(rootDir, importFailureSummaries));
          return;
        }
        // Same `buildFixtureGraph(config)` call `steps` above already makes
        // — `describeContract`'s own `needs`/`needs_browser` need it for the
        // same reason `summarize`'s do (that field's own doc comment):
        // without it, `describe`'s "full contract" would fall back to a
        // builtins-only guess instead of this project's real fixture graph.
        const graph = buildFixtureGraph(config);
        const contract = describeContract(entry, buildStepNames(vocabulary), rootDir, graph);
        stdout.write(
          `${JSON.stringify(versioned("describe", { ...contract, import_failures: importFailureSummaries }), null, 2)}\n`,
        );
        stderr.write(formatImportFailuresStderr(rootDir, importFailureSummaries));
        // Same rule as `steps` above, scoped to this one contract: an
        // import failure elsewhere in the project, this step's own
        // unreadable `from` entry (`from_errors`), this step's own
        // unreadable `needs` (`needs_error`), or an args/returns schema
        // JSON Schema cannot represent (`args_error` / `returns_error`).
        // Same reasoning in every case: the output went ahead and printed,
        // but it is not complete.
        if (
          importFailures.length > 0 ||
          (contract.kind === "typed" &&
            (contract.from_errors !== undefined ||
              contract.needs_error !== undefined ||
              contract.args_error !== undefined ||
              contract.returns_error !== undefined))
        ) {
          exitCode = 1;
        }
      } catch (error) {
        exitCode = refuse(sinks, error, help);
      }
    },
  };

  const doCommand: CommandModule<Record<string, never>, DoArgs> = {
    command: "do <name>",
    describe: "execute one typed step; step record to stdout",
    builder: (y: Argv) =>
      y
        .positional("name", {
          type: "string",
          demandOption: true,
          describe: "step name (as listed by `nuka steps`)",
        })
        .option("args", {
          type: "string",
          describe:
            "step arguments as a JSON object (may be omitted only when --use supplies every key)",
        })
        .option("session", {
          type: "string",
          describe: "carry login state across calls via a named session",
        })
        .option("env", {
          type: "string",
          describe: 'target a named environment (omit for the "default" environment)',
        })
        .option("use", {
          type: "string",
          array: true,
          describe:
            "step record id whose result fills this step's `from` keys (repeatable; --args still wins for a key it also sets)",
        })
        // `--args` has no `demandOption`: `--use` can supply every key, and
        // runDo refuses a missing `--args` after it knows the step exists,
        // so its do line can name `nuka describe <name>` for a real step.
        .check(rejectRepeatedFlags(["args", "session", "env"])) as Argv<DoArgs>,
    handler: async (args: Arguments<DoArgs>) => {
      if (argsFailed) return;
      const { runDo } = await import("./do.js");
      exitCode = await runDo({
        rootDir,
        name: args.name,
        argsJson: args.args ?? null,
        session: args.session ?? null,
        env: args.env ?? null,
        use: args.use ?? [],
        stdout: await recordStdout(),
        stderr,
      });
    },
  };

  const runCommand: CommandModule<Record<string, never>, RunArgs> = {
    command: "run [feature..]",
    describe:
      "check, then execute scenarios from a feature file, a Markdown oath, or a directory of them (featuresDir when none is given); step records + scenario records",
    builder: (y: Argv) =>
      refuseRemovedFlags(y, {
        session:
          "nuka run --session is removed: a scenario that needs login state gets it from a fixture or a Given step " +
          "its feature names. nuka do --session <name> still carries state across do calls.",
      })
        .positional("feature", {
          type: "string",
          array: true,
          describe:
            "feature file or Markdown oath, optionally with :line (e.g. features/checkout.feature:12), or a directory " +
            "walked recursively for .feature files and for Markdown files named in oaths (:line is refused on a directory); " +
            "omit to run featuresDir",
        })
        .option("check", {
          type: "boolean",
          default: true,
          describe:
            "before executing, report what nuka check reports for the selected scenarios and stop on an error; " +
            "--no-check skips it to run a scenario check refuses",
        })
        .option("env", {
          type: "string",
          describe: 'target a named environment (omit for the "default" environment)',
        })
        .option("quiet", {
          type: "boolean",
          default: false,
          describe: "suppress the per-step/per-scenario progress lines (output locations and the summary still print)",
        })
        .option("records", {
          type: "boolean",
          default: false,
          describe:
            "write one JSON scenario record per line to stdout (without it, stdout stays empty; " +
            "the records are written under .nukadoko/records/scenarios/ either way)",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe:
            "print the run's result (run.json: run id, verdict, counts, each scenario's record and rerun command) " +
            "on stdout as one JSON document, instead of one scenario record per line",
        })
        .option("concurrency", {
          type: "number",
          default: 1,
          describe:
            "run n worker processes at once, one whole feature file per worker (default 1; has nothing to do " +
            "for a target naming one file)",
        })
        .option("repeat", {
          type: "number",
          default: 1,
          describe:
            "run every selected scenario n times in this one invocation, whole selection first and then again " +
            "(default 1); for a failure that reproduces one time in several. Each execution is its own scenario " +
            "record under the one run_id, and a scenario that failed at least once gets a `repeat` line after the summary",
        })
        .option("summary", {
          type: "string",
          describe:
            "also write the Markdown run summary to this path, for a CI step that posts it on a pull request " +
            "(it is always written to the run's directory, and appended to $GITHUB_STEP_SUMMARY when that is set)",
        })
        .check(rejectRepeatedFlags(["env", "concurrency", "repeat", "summary"])) as Argv<RunArgs>,
    handler: async (args: Arguments<RunArgs>) => {
      if (argsFailed) return;
      const { runRun } = await import("./run.js");
      exitCode = await runRun({
        rootDir,
        featureArgs: args.feature ?? [],
        check: args.check ?? true,
        env: args.env ?? null,
        quiet: args.quiet ?? false,
        records: args.records ?? false,
        json: args.json ?? false,
        concurrency: args.concurrency ?? 1,
        repeat: args.repeat ?? 1,
        summaryPath: args.summary ?? null,
        // GitHub Actions sets this for every step; an empty value means no
        // file to append to.
        stepSummaryPath: process.env.GITHUB_STEP_SUMMARY || undefined,
        stdout: await recordStdout(),
        stderr,
      });
    },
  };

  const exploreCommand: CommandModule<Record<string, never>, ExploreArgs> = {
    command: "explore <file>",
    describe:
      "run one model or relation file against request-only steps; on a failure, the shortest scenario " +
      "found goes to stdout with the command that reruns it",
    builder: (y: Argv) =>
      y
        .positional("file", { type: "string", demandOption: true, describe: "a model or relation file under featuresDir" })
        .option("seed", { type: "number", describe: "the seed every choice comes from (printed when omitted)" })
        .option("runs", { type: "number", describe: `how many sequences a model runs (default ${DEFAULT_EXPLORE_RUNS})` })
        .option("length", { type: "number", describe: `the most steps in one sequence (default ${DEFAULT_EXPLORE_LENGTH})` })
        .option("env", { type: "string", describe: 'target a named environment (omit for the "default" environment)' })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "one JSON object on stdout: the verdict, the seed and counts, and on a failure each step's result and the scenario",
        })
        .check(rejectRepeatedFlags(["seed", "runs", "length", "env"])) as Argv<ExploreArgs>,
    handler: async (args: Arguments<ExploreArgs>) => {
      if (argsFailed) return;
      const { runExplore } = await import("./explore.js");
      exitCode = await runExplore({
        rootDir,
        file: args.file,
        seed: args.seed ?? null,
        runs: args.runs ?? DEFAULT_EXPLORE_RUNS,
        length: args.length ?? DEFAULT_EXPLORE_LENGTH,
        env: args.env ?? null,
        json: args.json ?? false,
        stdout: await recordStdout(),
        stderr,
      });
    },
  };

  const sessionListCommand: CommandModule<Record<string, never>, SessionListArgs> = {
    command: "list",
    describe: "list every session, across all environments, one line each with its environment",
    builder: (y: Argv) =>
      y.option("json", {
        type: "boolean",
        default: false,
        describe: "machine-readable output",
      }) as Argv<SessionListArgs>,
    handler: async (args: Arguments<SessionListArgs>) => {
      if (argsFailed) return;
      const { runSessionList } = await import("./session.js");
      exitCode = await runSessionList({
        rootDir,
        json: args.json ?? false,
        stdout,
        stderr,
      });
    },
  };

  const sessionClearCommand: CommandModule<Record<string, never>, SessionClearArgs> = {
    command: "clear [name]",
    describe: "delete a session, or every session for the environment when no name is given",
    builder: (y: Argv) =>
      y
        .positional("name", {
          type: "string",
          describe: "session name; omit to clear every session in the environment",
        })
        .option("env", {
          type: "string",
          describe: 'target a named environment (omit for the "default" environment)',
        })
        .check(rejectRepeatedFlags(["env"])) as Argv<SessionClearArgs>,
    handler: async (args: Arguments<SessionClearArgs>) => {
      if (argsFailed) return;
      const { runSessionClear } = await import("./session.js");
      exitCode = await runSessionClear({
        rootDir,
        name: args.name ?? null,
        env: args.env ?? null,
        stdout,
        stderr,
      });
    },
  };

  // `session start` and `session stop` were removed with live sessions.
  // The old spellings name what replaced them instead of yargs' bare
  // "Unknown argument". Hidden from the help: they run nothing.
  const removedSessionCommands: CommandModule[] = ["start", "stop"].map((verb) => ({
    command: verb,
    describe: false,
    builder: (y: Argv) => y.strict(false),
    handler: () => {
      if (argsFailed) return;
      exitCode = refuse(
        { json: argv.includes("--json"), stdout, stderr },
        `\`nuka session ${verb}\` was removed with live sessions; \`nuka do <step> --session <name>\` still carries ` +
          "login state across calls, and a page whose state cannot be repeated is explored through a Playwright " +
          "MCP server (see docs/upgrading.md in the nukadoko package)",
        "nuka do --help",
      );
    },
  }));

  const initCommand: CommandModule<Record<string, never>, InitArgs> = {
    command: "init",
    describe: "set up a project; ends with a self-check",
    builder: (y: Argv) =>
      refuseRemovedFlags(y, {
        "base-url": "nuka init --base-url is removed: set baseURL in the generated config after init.",
        "features-dir":
          "nuka init --features-dir is removed: init creates features/steps; for another directory, " +
          "set featuresDir in the generated config after init and move steps/ there.",
        "env-files": `nuka init --env-files is removed: ${INIT_WRITES_ENV_LINES}`,
        env: `nuka init --env is removed: ${INIT_WRITES_ENV_LINES}`,
      })
        .option("allure", {
          type: "boolean",
          describe: "turn the Allure emitter on in the generated config and write allurerc.mjs",
        })
        .option("server", {
          type: "string",
          nargs: 1,
          describe:
            '"<command>" with --server-url: write a server fixture that starts this command (split on whitespace, no shell) for each scenario that sends a request, and stops it after',
        })
        .option("server-url", {
          type: "string",
          nargs: 1,
          describe: "<url> the URL the --server command listens at, written as baseURL; the fixture waits until its port accepts a connection",
        })
        .check(rejectRepeatedFlags(["server", "server-url"])) as Argv<InitArgs>,
    handler: async (args: Arguments<InitArgs>) => {
      if (argsFailed) return;
      const { runInit } = await import("./init.js");
      exitCode = await runInit({
        rootDir,
        allure: args.allure ?? false,
        server: args.server ?? null,
        serverUrl: args.serverUrl ?? null,
        stdout,
        stderr,
      });
    },
  };

  const scaffoldCommand: CommandModule<Record<string, never>, ScaffoldArgs> = {
    command: "scaffold [name]",
    describe: "typed step template that fails until implemented",
    builder: (y: Argv) =>
      y
        .positional("name", {
          type: "string",
          describe: "step name, kebab-case (becomes the step's file name); leave it out with --feature",
        })
        .option("feature", {
          type: "string",
          describe:
            "<path> a feature file (or a directory of them): write one stub for each line nuka check calls undefined-step, its pattern read from the line",
        })
        .option("pattern", {
          type: "string",
          nargs: 1,
          describe: "the feature line text the step matches; each {key:type} capture becomes an args field",
        })
        .option("then", {
          type: "boolean",
          default: false,
          describe: "an assertion for a Then line: mutates: false and no returns",
        })
        .option("command", {
          type: "string",
          describe:
            "[entry point] a When step that runs a program in scratch.dir() (or in --cwd's directory) and returns exitCode, stdout, and stderr; the entry point must be an existing file and is written into the file, or left as a TODO the step refuses to run with",
        })
        .option("description", {
          type: "string",
          nargs: 1,
          describe: "what the step does, written as its description; without it the description is a TODO nuka tend reports",
        })
        .option("from", {
          type: "string",
          array: true,
          describe:
            "<step>.<key>: chain that key of an earlier step's returns into args (import, args field, from entry); repeatable, and one key given for several steps lists each as a candidate producer",
        })
        .option("cwd", {
          type: "string",
          nargs: 1,
          describe: "<key> with --command: run the program in the directory this args key holds (a --from key or a capture) instead of an empty scratch.dir()",
        })
        .option("argv", {
          type: "string",
          nargs: 1,
          describe:
            "<key> with --command: split this string capture into argv elements on whitespace only (no quoting), so one feature line can carry every argument and flag",
        })
        .option("request", {
          type: "string",
          nargs: 1,
          describe:
            '"<METHOD> <path>": a When step that sends one request through Playwright\'s request (resolved against baseURL) and returns status and body; each {key} in the path is that args key\'s value',
        })
        .option("body", {
          type: "string",
          nargs: 1,
          describe: "<key> with --request: send this args key (a capture, a --from key, or docstring) as the request's data",
        })
        .option("replace", {
          type: "boolean",
          default: false,
          describe:
            "overwrite the step file while it is still, byte for byte, what scaffold writes under some set of options (a --feature stub, a --command or --from step nobody edited); any other file is refused",
        })
        // A pattern or a description is free text a feature line may start
        // with a dash, so each takes the next word whatever it starts with,
        // as getopt_long does for a required value, and keeps its quotes.
        .parserConfiguration({ "nargs-eats-options": true })
        .check(rejectRepeatedFlags(["pattern", "command", "description", "feature", "cwd", "argv", "request", "body"]))
        .check((args) => {
          if (args.feature !== undefined) return featureScaffoldConflict(args as unknown as ScaffoldArgs) ?? true;
          if (args.name !== undefined) return true;
          // A flag given no value is `true` here: the parser has already
          // refused it, and left the name unbound as well.
          const given: Record<string, unknown> = args;
          if (given.pattern === true || given.description === true) return true;
          // The name is optional only beside --feature; this also says why
          // it is missing when the name went to --command.
          const missing = "Missing required argument: name (or --feature <path>)";
          return typeof args.command === "string" && VALID_STEP_NAME.test(args.command)
            ? `${missing}\n${commandTookTheName(args.command)}`
            : missing;
        }) as Argv<ScaffoldArgs>,
    handler: async (args: Arguments<ScaffoldArgs>) => {
      if (argsFailed) return;
      if (args.feature !== undefined) {
        const { runScaffoldFeature } = await import("./scaffold-feature.js");
        exitCode = await runScaffoldFeature({ rootDir, feature: args.feature, stdout, stderr });
        return;
      }
      const name = args.name;
      if (name === undefined) return;
      const { runScaffold } = await import("./scaffold.js");
      exitCode = await runScaffold({
        rootDir,
        name,
        pattern: args.pattern ?? null,
        then: args.then ?? false,
        command: typeof args.command === "string",
        entryPoint: typeof args.command === "string" && args.command !== "" ? args.command : null,
        // `--command <value>` written before the name, rather than `--command=<value>` or after it.
        commandBeforeName: argv.indexOf("--command") !== -1 && argv.indexOf("--command") < argv.indexOf(name),
        description: args.description ?? null,
        from: args.from ?? [],
        cwd: args.cwd ?? null,
        argvKey: args.argv ?? null,
        request: args.request ?? null,
        bodyKey: args.body ?? null,
        replace: args.replace ?? false,
        argv,
        stdout,
        stderr,
      });
    },
  };

  const checkCommand: CommandModule<Record<string, never>, CheckArgs> = {
    command: "check [feature..]",
    describe:
      "static checks: pattern/schema mismatches, Then binding to mutating steps, undefined steps per feature, duplicate patterns, config coherence",
    builder: (y: Argv) =>
      y
        .positional("feature", {
          type: "string",
          array: true,
          describe:
            "feature file, Markdown oath, or directory, selected the way nuka run selects them (no :line); " +
            "omit to check every feature under featuresDir and additionalFeatureDirs and every path in oaths",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "machine-readable output",
        })
        .option("codes", {
          type: "boolean",
          default: false,
          describe:
            "list every finding code nuka check can produce, with a one-line description, instead of checking a project",
        }) as Argv<CheckArgs>,
    handler: async (args: Arguments<CheckArgs>) => {
      if (argsFailed) return;
      const { runCheck } = await import("./check.js");
      exitCode = await runCheck({
        rootDir,
        json: args.json ?? false,
        codes: args.codes ?? false,
        targets: args.feature ?? [],
        stdout,
        stderr,
      });
    },
  };

  const cleanCommand: CommandModule<Record<string, never>, CleanArgs> = {
    command: "clean",
    describe:
      "delete accumulated records/cache/export under the state directory; refuses an allure.resultsDir or messages.output that is the project root, outside the project, or a parent of the state directory",
    builder: (y: Argv) =>
      refuseRemovedFlags(y, {
        records: `nuka clean --records is removed: ${CLEAN_REMOVES_EVERY_CATEGORY}`,
        cache: `nuka clean --cache is removed: ${CLEAN_REMOVES_EVERY_CATEGORY}`,
        export: `nuka clean --export is removed: ${CLEAN_REMOVES_EVERY_CATEGORY}`,
      })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "list what would be removed without removing it",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "machine-readable output",
        }) as Argv<CleanArgs>,
    handler: async (args: Arguments<CleanArgs>) => {
      if (argsFailed) return;
      const { runClean } = await import("./clean.js");
      exitCode = await runClean({
        rootDir,
        dryRun: args.dryRun ?? false,
        json: args.json ?? false,
        stdout,
        stderr,
      });
    },
  };

  const tendCommand: CommandModule<Record<string, never>, TendArgs> = {
    command: "tend",
    describe: "what is rotting rather than what is broken: unused declarations, unbound steps, stale fixtures",
    builder: (y: Argv) =>
      refuseRemovedFlags(y, {
        all: "nuka tend --all is removed: a plain nuka tend reports every code.",
      })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "machine-readable output",
        })
        .option("fail-on", {
          type: "string",
          array: true,
          describe:
            "exit 1 when a finding with this code is reported (repeatable, or comma-separated); every finding " +
            "stays a note in the output, only the exit code changes. For a job that gates on one note, such as " +
            "pattern-unbound",
        })
        .option("codes", {
          type: "boolean",
          default: false,
          describe:
            "list every finding code nuka tend can report, with a one-line description, instead of tending a project",
        }) as Argv<TendArgs>,
    handler: async (args: Arguments<TendArgs>) => {
      if (argsFailed) return;
      const { runTend } = await import("./tend.js");
      exitCode = await runTend({
        rootDir,
        json: args.json ?? false,
        codes: args.codes ?? false,
        failOn: (args["fail-on"] ?? []).flatMap((value) => value.split(",")).map((code) => code.trim()).filter((code) => code.length > 0),
        stdout,
        stderr,
      });
    },
  };

  const skillPathCommand: CommandModule<Record<string, never>, SkillPathArgs> = {
    command: "path",
    describe: "print the directory holding this package's own skills, one absolute path",
    handler: async () => {
      if (argsFailed) return;
      const { runSkillPath } = await import("./skill.js");
      exitCode = await runSkillPath({ stdout, stderr });
    },
  };

  const skillCommand: CommandModule = {
    command: "skill",
    describe: "path the agent-facing skills' source directory",
    builder: (y: Argv) => y.command(skillPathCommand).demandCommand(1).strict(),
    handler: () => {
      // Never invoked: `demandCommand(1)` on the sub-builder above requires
      // `path`, same pattern as `sessionCommand` below.
    },
  };

  // `harvest` was removed. The old spelling names the upgrading note
  // instead of yargs' bare "Unknown argument", so a script that still
  // calls it learns what replaced it. Hidden from the help: it runs nothing.
  const removedHarvestCommand: CommandModule = {
    command: "harvest",
    describe: false,
    builder: (y: Argv) => y.strict(false),
    handler: () => {
      if (argsFailed) return;
      exitCode = refuse(
        { json: argv.includes("--json"), stdout, stderr },
        "`nuka harvest` was removed; write the scenario from the steps you ran, then run `nuka check` " +
          "(see docs/upgrading.md in the nukadoko package)",
        "nuka check",
      );
    },
  };

  // `explore` was a top-level command until it moved under `experimental`.
  // Hidden from the help: it runs nothing, and names the new spelling so a
  // script written against the old one says what to change.
  const movedExploreCommand: CommandModule = {
    command: "explore",
    describe: false,
    builder: (y: Argv) => y.strict(false),
    handler: async () => {
      if (argsFailed) return;
      exitCode = refuse(
        { json: argv.includes("--json"), stdout, stderr },
        "`nuka explore` moved to `nuka experimental explore`; run that instead, with the same arguments",
        movedExploreCommandLine(argv),
      );
    },
  };

  const experimentalCommand: CommandModule = {
    command: "experimental",
    describe:
      "EXPERIMENTAL: commands this package is still trying out; any of them may change shape or " +
      "disappear release to release without the deprecation notice a stable command would get",
    builder: (y: Argv) => y.command(namingMissingConfig(exploreCommand)).demandCommand(1).strict(),
    handler: () => {
      // Never invoked: `demandCommand(1)` on the sub-builder above requires
      // a subcommand, same pattern as `skillCommand`/`sessionCommand`.
    },
  };

  const sessionCommand: CommandModule = {
    command: "session",
    describe: "list|clear sessions",
    builder: (y: Argv) =>
      removedSessionCommands
        .reduce(
          (sub: Argv, command) => sub.command(command),
          y.command(namingMissingConfig(sessionListCommand)).command(namingMissingConfig(sessionClearCommand)),
        )
        .demandCommand(1)
        .strict(),
    handler: () => {
      // Never invoked: `demandCommand(1)` on the sub-builder above requires
      // one of `list`/`clear`, so this bare handler only
      // exists to satisfy yargs' CommandModule shape.
    },
  };

  // The order a newcomer meets them in: the everyday loop first, then the
  // commands for exploring a path one step at a time, then upkeep.
  const helpGroups: HelpGroup[] = [
    {
      heading: "Everyday",
      commands: [
        initCommand,
        scaffoldCommand,
        namingMissingConfig(checkCommand),
        namingMissingConfig(runCommand),
        namingMissingConfig(stepsCommand),
        namingMissingConfig(describeCommand),
      ],
    },
    {
      heading: "Exploring",
      commands: [namingMissingConfig(doCommand), sessionCommand],
    },
    { heading: "Upkeep", commands: [namingMissingConfig(tendCommand), namingMissingConfig(cleanCommand), skillCommand] },
    { heading: "Experimental", commands: [experimentalCommand] },
  ];

  const commandNames = new Map<string, readonly string[]>(
    helpGroups
      .flatMap((group) => group.commands)
      .concat(movedExploreCommand, removedHarvestCommand)
      .map((command) => [firstWord(command.command), []]),
  );
  commandNames.set("session", [sessionListCommand, sessionClearCommand, ...removedSessionCommands].map((c) => firstWord(c.command)));
  commandNames.set("experimental", [firstWord(exploreCommand.command)]);
  commandNames.set("skill", [firstWord(skillPathCommand.command)]);

  const parser = helpGroups
    .flatMap((group) => group.commands)
    .reduce((y: Argv, command) => y.command(withoutFlatListing(command)), yargs(argv))
    .scriptName("nuka")
    // Pinned, not left to `LANG`: yargs translates its own chrome (usage
    // headers, "Commands:", its built-in error wording) but every command
    // description here is written in English, so an inherited locale
    // produces a half-translated help screen. One language throughout beats
    // a localized frame around untranslated content — and a user reporting
    // an error message quotes the same string the maintainer reads.
    .locale("en")
    .version(ownVersion)
    .exitProcess(false)
    .fail((msg: string | null, err: Error | undefined) => {
      argsFailed = true;
      // yargs passes `msg: null` with the error only when a handler threw.
      if (msg === null && err !== undefined) {
        exitCode = 1;
        stderr.write(`${err.message}\n`);
        return;
      }
      // Anything else is the invocation itself: an unknown flag or command,
      // a missing argument, or a `.check()` that refused. One parse can fail
      // more than once (a missing name, then why it is missing), and all of
      // them become one refusal after the parse, so `--json` still gets
      // exactly one object.
      usageFailures.push(err?.message ?? msg ?? "unknown error");
      usageFailureDos.push(err instanceof RefusalError ? err.do : undefined);
    })
    .usage(
      `nuka <command>\n\n${renderCommandGroups(
        "nuka",
        helpGroups.map((group) => ({ heading: group.heading, lines: helpLines(group) })),
        HELP_WIDTH,
      )}`,
    )
    .wrap(null)
    .epilogue(AGENT_ENTRY_POINT)
    .command(removedHarvestCommand)
    .command(movedExploreCommand)
    .demandCommand(1)
    .strict()
    .help();

  // A thrown command handler is reported by `.fail()` above, which writes
  // the message and sets `exitCode`. yargs still rejects `parseAsync` with
  // the same error: the `.catch` on the handler promise calls `fail` and
  // leaves that rejection in place. If the rejection leaves `runCli`, the
  // process entry's top-level await fails and Node prints a second copy
  // (a stack, the errno object, and the runtime version) after the line
  // already written. Catching it here keeps one failure to one line and
  // the exit code `.fail()` already chose.
  // A rejection `.fail()` never saw still exits 1, with its message on
  // stderr: that is the same promise this function makes for every other
  // failure.
  try {
    await parser.parseAsync();
  } catch (error) {
    if (!argsFailed) {
      exitCode = 1;
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (usageFailures.length > 0) {
    exitCode = refuse(
      { json: argv.includes("--json"), stdout, stderr },
      usageFailures.join("\n"),
      (usageFailures.length === 1 ? usageFailureDos[0] : undefined) ?? helpFor(commandPathOf(argv, commandNames)),
    );
  }
  return exitCode;
}
