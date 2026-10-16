import yargs from "yargs";
// TODO(types): @types/yargs is pinned to the 17.x line (no 18.x types on
// DefinitelyTyped yet); CommandModule/Argv here
// are the 17.x shapes. yargs 18's runtime behavior used below (command
// builders, .fail(), parseAsync()) is unchanged from 17, so this is a type
// approximation, not a behavior mismatch.
import type { Arguments, Argv, CommandModule } from "yargs";
import { buildFixtureGraph } from "../fixture/graph.js";
import { readOwnVersion } from "../version.js";
import { runCheck } from "./check.js";
import { runClean } from "./clean.js";
import { runDo } from "./do.js";
import { DEFAULT_EXPLORE_LENGTH, DEFAULT_EXPLORE_RUNS, runExplore } from "./explore.js";
import { runHarvest } from "./harvest.js";
import { HELP_WIDTH, type HelpGroup, helpLines, renderCommandGroups, withoutFlatListing } from "./help-groups.js";
import { runInit } from "./init.js";
import { runMcpTools } from "./mcp-tools.js";
import { runRun } from "./run.js";
import { runScaffold } from "./scaffold.js";
import {
  MAX_IDLE_TIMEOUT_SECONDS,
  runSessionClear,
  runSessionList,
  runSessionStart,
  runSessionStop,
} from "./session.js";
import { runSkillPath } from "./skill.js";
import { runTend } from "./tend.js";
import { runWebmcpTools } from "./webmcp.js";
import {
  assertFeaturesDirExists,
  buildStepNames,
  describeContract,
  formatImportFailuresStderr,
  formatVocabulary,
  formatVocabularyError,
  loadVocabulary,
  summarize,
  toImportFailureSummaries,
} from "./vocabulary.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { divertProcessStdoutToStderr } from "../run/step-stdout.js";

// Responsibility: wires the commands (`steps`, `describe`, `do`, `run`,
// `session list`/`clear`/`start`/`stop`, `init`, `scaffold`, `check`,
// `clean`, `tend`, `harvest`, `skill path`, `experimental mcp-tools`,
// `experimental webmcp-tools`)
// to yargs and turns any failure — yargs' own (bad flags, no command) or
// ours (config/discovery errors, unknown step name) — into stderr output
// plus a non-zero exit code, without ever calling `process.exit` itself.
// That is `cli.ts`'s job, so this function stays callable directly from
// tests. `do`'s own setup/execution split and step record writing lives in
// cli/do.ts, including deciding whether `--session` reaches a live
// session's own process (src/live/daemon.ts) or builds a fresh `ctx` the
// way it always has; `run`'s own execution lives in cli/run.ts;
// `session`'s own list/clear/start/stop logic lives in
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
// `experimental webmcp-tools`'s own browser launch and tool-reading logic
// lives in cli/webmcp.ts (thin wiring) and src/webmcp/list-tools.ts (the
// actual work), nested one command under `experimental` rather than a
// top-level command so the word is unavoidable at every call site;
// `mcp-tools`'s own connect-list-close logic lives in cli/mcp-tools.ts
// (thin wiring, reaching src/mcp/list-tools.ts through a dynamic
// `import()` rather than a static one; that file's own header explains
// why), under `experimental` too: it lists another server's tools, which
// no step of the everyday loop needs, so the top-level help keeps it out
// of a newcomer's first screen; `harvest`'s own draft-rendering and
// round-trip logic lives in cli/harvest.ts (thin wiring) and
// src/harvest/* (the actual work), the same split as `check`/`tend`;
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
  session?: string;
  env?: string;
  /** Suppresses the per-step/per-scenario progress lines — the
   * output-location and summary lines still print; run.ts's own header
   * explains why those two are exempt. */
  quiet?: boolean;
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

interface HarvestArgs {
  /** yargs' own `<name..>` variadic positional syntax collects every
   * positional token into this array, in the order given on the command
   * line — `nuka harvest`'s own handler re-sorts them by each record's
   * `started_at` before rendering anything (docs/spec.md "Harvesting"). */
  stepRecordIds: string[];
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

interface SessionStartArgs {
  name: string;
  env?: string;
  /** yargs' `type: "number"` accepts NaN, 0, a negative, and a value past
   * Node's 32-bit timer limit. `idleTimeoutRefusal` (session.ts) refuses
   * those before a session starts. */
  idleTimeout?: number;
}

interface SessionStopArgs {
  name: string;
  env?: string;
}

interface InitArgs {
  baseUrl?: string;
  featuresDir?: string;
  allure?: boolean;
  env?: boolean;
}

interface ScaffoldArgs {
  name: string;
  pattern?: string;
  then?: boolean;
  command?: boolean;
  from?: string[];
}

interface CheckArgs {
  json?: boolean;
  codes?: boolean;
  feature?: string;
}

interface TendArgs {
  json?: boolean;
  all?: boolean;
  /** `--fail-on`; yargs collects a repeated flag into an array. */
  "fail-on"?: string[];
}

interface CleanArgs {
  dryRun?: boolean;
  records?: boolean;
  cache?: boolean;
  export?: boolean;
  json?: boolean;
}

interface WebmcpToolsArgs {
  url: string;
  json?: boolean;
}

interface McpToolsArgs {
  json?: boolean;
  /** Every token after `--` (`command` plus its own args), populated by
   * `.parserConfiguration({ "populate--": true })` below — yargs' own
   * `Arguments<T>` types this as `unknown` via its index signature, so the
   * builder's own return type states the real shape here instead. */
  "--"?: string[];
}

type SkillPathArgs = Record<string, never>;

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
  const recordStdout = (): WritableSink => options.stdout ?? divertProcessStdoutToStderr();

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
        const summaries = [...vocabulary.values()].map((entry) => summarize(entry, stepNames, graph));
        const importFailureSummaries = toImportFailureSummaries(importFailures);
        if (args.json) {
          // Top-level shape change from a bare array to `{ steps,
          // import_failures }` — 0.x accepts the break; the alternative,
          // silently dropping `import_failures` off a bare array, is
          // exactly the "machine reader treats an incomplete list as
          // complete" failure this field exists to prevent.
          stdout.write(
            `${JSON.stringify({ steps: summaries, import_failures: importFailureSummaries }, null, 2)}\n`,
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
        exitCode = 1;
        stderr.write(`${formatVocabularyError(error)}\n`);
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
          exitCode = 1;
          stderr.write(`Unknown step: ${args.name}\n`);
          stderr.write(formatImportFailuresStderr(rootDir, importFailureSummaries));
          return;
        }
        // Same `buildFixtureGraph(config)` call `steps` above already makes
        // — `describeContract`'s own `needs`/`needs_browser` need it for the
        // same reason `summarize`'s do (that field's own doc comment):
        // without it, `describe`'s "full contract" would fall back to a
        // builtins-only guess instead of this project's real fixture graph.
        const graph = buildFixtureGraph(config);
        const contract = describeContract(entry, buildStepNames(vocabulary), graph);
        stdout.write(
          `${JSON.stringify({ ...contract, import_failures: importFailureSummaries }, null, 2)}\n`,
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
        exitCode = 1;
        stderr.write(`${formatVocabularyError(error)}\n`);
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
        // `--args` lost its `demandOption`: once `--use` is given,
        // "arguments come from the chain" is already stated, so making the
        // caller also write `--args '{}'` for a step every key of which
        // `from` fills is pure ritual. This `.check()`
        // is what still refuses the case that matters — neither flag given
        // — kept in the same yargs layer `demandOption` used to occupy
        // (not moved into do.ts) so a bad invocation still fails before any
        // step-record-writing setup runs, exactly as it did before.
        //
        // `--args` is deliberately not made unconditionally optional: doing
        // so would let a typo'd `nuka do <step>` (missing `--args`
        // entirely, `--use` also forgotten) parse successfully and only
        // fail later at args-schema validation, deep inside the execution
        // phase, instead of failing fast here. `--use` is the one signal
        // that specifically means "arguments come from the chain instead",
        // so only its presence earns the exemption.
        .check((checkArgs) => {
          const useValues = checkArgs.use as string[] | undefined;
          if (checkArgs.args === undefined && (useValues === undefined || useValues.length === 0)) {
            throw new Error("--args is required unless --use supplies this step's arguments");
          }
          return true;
        })
        .check(rejectRepeatedFlags(["args", "session", "env"])) as Argv<DoArgs>,
    handler: async (args: Arguments<DoArgs>) => {
      if (argsFailed) return;
      exitCode = await runDo({
        rootDir,
        name: args.name,
        // `--args`'s own `.check()` above already refused this when both
        // it and `--use` are absent, so `??` here only ever fires when
        // `--use` supplies this step's arguments — `"{}"` gives do.ts's
        // `from` injection (execution phase) an object to fill.
        argsJson: args.args ?? "{}",
        session: args.session ?? null,
        env: args.env ?? null,
        use: args.use ?? [],
        stdout: recordStdout(),
        stderr,
      });
    },
  };

  const runCommand: CommandModule<Record<string, never>, RunArgs> = {
    command: "run [feature..]",
    describe:
      "check, then execute scenarios from a feature file, a Markdown oath, or a directory of them (featuresDir when none is given); step records + scenario records",
    builder: (y: Argv) =>
      y
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
        .option("session", {
          type: "string",
          describe: "carry login state across calls via a named session",
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
        .option("concurrency", {
          type: "number",
          default: 1,
          describe:
            "run n worker processes at once, one whole feature file per worker (default 1; has nothing to do " +
            "for a target naming one file, and drops back to 1 under --session)",
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
        .check(rejectRepeatedFlags(["session", "env", "concurrency", "repeat", "summary"])) as Argv<RunArgs>,
    handler: async (args: Arguments<RunArgs>) => {
      if (argsFailed) return;
      exitCode = await runRun({
        rootDir,
        featureArgs: args.feature ?? [],
        check: args.check ?? true,
        session: args.session ?? null,
        env: args.env ?? null,
        quiet: args.quiet ?? false,
        concurrency: args.concurrency ?? 1,
        repeat: args.repeat ?? 1,
        summaryPath: args.summary ?? null,
        // GitHub Actions sets this for every step; an empty value means no
        // file to append to.
        stepSummaryPath: process.env.GITHUB_STEP_SUMMARY || undefined,
        stdout: recordStdout(),
        stderr,
      });
    },
  };

  const harvestCommand: CommandModule<Record<string, never>, HarvestArgs> = {
    command: "harvest <step-record-ids..>",
    describe:
      "one feature draft to stdout from `nuka do`'s own step record ids, in the order they actually " +
      "ran; every line's keyword is `*` and its name is a placeholder (provenance goes to stderr only)",
    builder: (y: Argv) =>
      y.positional("step-record-ids", {
        type: "string",
        array: true,
        demandOption: true,
        describe: "one or more step record ids, as printed by `nuka do` (no time window, no --since)",
        // yargs' own variadic-positional overloads produce a type its
        // `.check()`/`.alias()` chain (used internally, not by this file)
        // can't structurally match against `HarvestArgs` — `unknown` first,
        // same remedy TS itself suggests, since the runtime shape (yargs'
        // own camelCase expansion of "step-record-ids") is exactly
        // `HarvestArgs` regardless.
      }) as unknown as Argv<HarvestArgs>,
    handler: async (args: Arguments<HarvestArgs>) => {
      if (argsFailed) return;
      exitCode = await runHarvest({
        rootDir,
        stepRecordIds: args.stepRecordIds,
        stdout,
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
      exitCode = await runExplore({
        rootDir,
        file: args.file,
        seed: args.seed ?? null,
        runs: args.runs ?? DEFAULT_EXPLORE_RUNS,
        length: args.length ?? DEFAULT_EXPLORE_LENGTH,
        env: args.env ?? null,
        json: args.json ?? false,
        stdout: recordStdout(),
        stderr,
      });
    },
  };

  const sessionListCommand: CommandModule<Record<string, never>, SessionListArgs> = {
    command: "list",
    describe: "list every session, across all environments; --json names each one's environment",
    builder: (y: Argv) =>
      y.option("json", {
        type: "boolean",
        default: false,
        describe: "machine-readable output",
      }) as Argv<SessionListArgs>,
    handler: async (args: Arguments<SessionListArgs>) => {
      if (argsFailed) return;
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
      exitCode = await runSessionClear({
        rootDir,
        name: args.name ?? null,
        env: args.env ?? null,
        stdout,
        stderr,
      });
    },
  };

  const sessionStartCommand: CommandModule<Record<string, never>, SessionStartArgs> = {
    command: "start <name>",
    describe: "start a live session: a detached process holding one ctx open across `nuka do --session` calls",
    builder: (y: Argv) =>
      y
        .positional("name", {
          type: "string",
          demandOption: true,
          describe: "session name (as later passed to `nuka do --session`)",
        })
        .option("env", {
          type: "string",
          describe: 'target a named environment (omit for the "default" environment)',
        })
        .option("idle-timeout", {
          type: "number",
          default: 900,
          describe:
            "seconds of no execution before the session stops itself " +
            `(default 900; a finite number greater than 0 and at most ${MAX_IDLE_TIMEOUT_SECONDS})`,
        })
        .check(rejectRepeatedFlags(["env", "idle-timeout"])) as Argv<SessionStartArgs>,
    handler: async (args: Arguments<SessionStartArgs>) => {
      if (argsFailed) return;
      exitCode = await runSessionStart({
        rootDir,
        name: args.name,
        env: args.env ?? null,
        idleTimeoutSeconds: args.idleTimeout ?? 900,
        stdout,
        stderr,
      });
    },
  };

  const sessionStopCommand: CommandModule<Record<string, never>, SessionStopArgs> = {
    command: "stop <name>",
    describe: "stop a live session: persists its storageState, then ends the process",
    builder: (y: Argv) =>
      y
        .positional("name", {
          type: "string",
          demandOption: true,
          describe: "session name, as given to `nuka session start`",
        })
        .option("env", {
          type: "string",
          describe: 'target a named environment (omit for the "default" environment)',
        })
        .check(rejectRepeatedFlags(["env"])) as Argv<SessionStopArgs>,
    handler: async (args: Arguments<SessionStopArgs>) => {
      if (argsFailed) return;
      exitCode = await runSessionStop({
        rootDir,
        name: args.name,
        env: args.env ?? null,
        stdout,
        stderr,
      });
    },
  };

  const initCommand: CommandModule<Record<string, never>, InitArgs> = {
    command: "init",
    describe: "set up a project; ends with a self-check",
    builder: (y: Argv) =>
      y
        .option("base-url", {
          type: "string",
          describe: "baseURL to record in the generated config",
        })
        .option("features-dir", {
          type: "string",
          describe: "featuresDir to use instead of the default, recorded in the generated config",
        })
        .option("allure", {
          type: "boolean",
          describe: "turn the Allure emitter on in the generated config and write allurerc.mjs",
        })
        .option("env", {
          type: "boolean",
          describe: "add .env, .env.*, and !.env.example to .gitignore, for a project that keeps env files",
        })
        .check(rejectRepeatedFlags(["base-url", "features-dir"])) as Argv<InitArgs>,
    handler: async (args: Arguments<InitArgs>) => {
      if (argsFailed) return;
      exitCode = await runInit({
        rootDir,
        baseUrl: args.baseUrl ?? null,
        featuresDir: args.featuresDir ?? null,
        allure: args.allure ?? false,
        env: args.env ?? false,
        stdout,
        stderr,
      });
    },
  };

  const scaffoldCommand: CommandModule<Record<string, never>, ScaffoldArgs> = {
    command: "scaffold <name>",
    describe: "typed step template that fails until implemented",
    builder: (y: Argv) =>
      y
        .positional("name", {
          type: "string",
          demandOption: true,
          describe: "step name, kebab-case (becomes the step's file name)",
        })
        .option("pattern", {
          type: "string",
          describe: "the feature line text the step matches; each {key:type} capture becomes an args field",
        })
        .option("then", {
          type: "boolean",
          default: false,
          describe: "an assertion for a Then line: mutates: false and no returns",
        })
        .option("command", {
          type: "boolean",
          default: false,
          describe:
            "a When step that runs a program in scratch.dir() and returns exitCode, stdout, and stderr; the entry point is the one TODO",
        })
        .option("from", {
          type: "string",
          array: true,
          describe:
            "<step>.<key>: chain that key of an earlier step's returns into args (import, args field, from entry); repeatable",
        })
        .check(rejectRepeatedFlags(["pattern"])) as Argv<ScaffoldArgs>,
    handler: async (args: Arguments<ScaffoldArgs>) => {
      if (argsFailed) return;
      exitCode = await runScaffold({
        rootDir,
        name: args.name,
        pattern: args.pattern ?? null,
        then: args.then ?? false,
        command: args.command ?? false,
        from: args.from ?? [],
        stdout,
        stderr,
      });
    },
  };

  const checkCommand: CommandModule<Record<string, never>, CheckArgs> = {
    command: "check [feature]",
    describe:
      "static checks: pattern/schema mismatches, Then binding to mutating steps, undefined steps per feature, duplicate patterns, config coherence",
    builder: (y: Argv) =>
      y
        .positional("feature", {
          type: "string",
          describe:
            "check only this feature file or Markdown oath instead of every feature under featuresDir and every path in oaths (no :line)",
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
      exitCode = await runCheck({
        rootDir,
        json: args.json ?? false,
        codes: args.codes ?? false,
        featureArg: args.feature,
        stdout,
        stderr,
      });
    },
  };

  const cleanCommand: CommandModule<Record<string, never>, CleanArgs> = {
    command: "clean",
    describe:
      "delete accumulated records/cache/export under the state directory; refuses while any session is live; refuses an allure.resultsDir or messages.output that is the project root, outside the project, or a parent of the state directory",
    builder: (y: Argv) =>
      y
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "list what would be removed without removing it",
        })
        .option("records", {
          type: "boolean",
          default: false,
          describe: "clean only step/scenario records (default: every category, when none of --records/--cache/--export is given)",
        })
        .option("cache", {
          type: "boolean",
          default: false,
          describe: "clean only session cache files (default: every category, when none of --records/--cache/--export is given)",
        })
        .option("export", {
          type: "boolean",
          default: false,
          describe: "clean only allure-results, messages.ndjson, and each run's own messages.<run_id>.ndjson (default: every category, when none of --records/--cache/--export is given)",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "machine-readable output",
        }) as Argv<CleanArgs>,
    handler: async (args: Arguments<CleanArgs>) => {
      if (argsFailed) return;
      exitCode = await runClean({
        rootDir,
        dryRun: args.dryRun ?? false,
        records: args.records ?? false,
        cache: args.cache ?? false,
        exportArtifacts: args.export ?? false,
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
      y
        .option("json", {
          type: "boolean",
          default: false,
          describe: "machine-readable output",
        })
        .option("all", {
          type: "boolean",
          default: false,
          describe:
            "also report step-rationale-missing and schema-field-undescribed, which are left out by default " +
            "(naming one in --fail-on reports it too)",
        })
        .option("fail-on", {
          type: "string",
          array: true,
          describe:
            "exit 1 when a finding with this code is reported (repeatable, or comma-separated); every finding " +
            "stays a note in the output, only the exit code changes. For a job that gates on one note, such as " +
            "pattern-unbound",
        }) as Argv<TendArgs>,
    handler: async (args: Arguments<TendArgs>) => {
      if (argsFailed) return;
      exitCode = await runTend({
        rootDir,
        json: args.json ?? false,
        all: args.all ?? false,
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

  const mcpToolsCommand: CommandModule<Record<string, never>, McpToolsArgs> = {
    command: "mcp-tools",
    describe:
      "list the tools an MCP server declares over stdio: `nuka experimental mcp-tools -- <command> [args...]` " +
      "connects to it just long enough to ask. A separate face from `nuka steps`; nothing this " +
      "command reports is ever part of that vocabulary",
    builder: (y: Argv) =>
      y
        .option("json", {
          type: "boolean",
          default: false,
          describe: "machine-readable output; each tool's inputSchema exactly as the server declared it",
        })
        // Everything after `--` becomes the server's own command line
        // rather than being parsed as this command's own flags — the same
        // reason `npm run <script> -- --flag` needs it: without this, a
        // flag meant for the server (say `--port`) would be consumed by
        // yargs itself instead of reaching the server.
        .parserConfiguration({ "populate--": true }) as Argv<McpToolsArgs>,
    handler: async (args: Arguments<McpToolsArgs>) => {
      if (argsFailed) return;
      const rest = args["--"] ?? [];
      const [command, ...serverArgs] = rest;
      exitCode = await runMcpTools({
        command,
        args: serverArgs,
        json: args.json ?? false,
        stdout,
        stderr,
      });
    },
  };

  const webmcpToolsCommand: CommandModule<Record<string, never>, WebmcpToolsArgs> = {
    command: "webmcp-tools <url>",
    describe:
      "EXPERIMENTAL, may change or disappear without notice: list the WebMCP tools a page has " +
      "declared via navigator.modelContext.registerTool. A separate face from `nuka steps`; " +
      "nothing this command reports is ever part of that vocabulary",
    builder: (y: Argv) =>
      y
        .positional("url", {
          type: "string",
          demandOption: true,
          describe: "absolute URL to load and read declared tools from (no baseURL resolution)",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "machine-readable output; each tool's inputSchema exactly as the page declared it",
        }) as Argv<WebmcpToolsArgs>,
    handler: async (args: Arguments<WebmcpToolsArgs>) => {
      if (argsFailed) return;
      exitCode = await runWebmcpTools({
        rootDir,
        url: args.url,
        json: args.json ?? false,
        stdout,
        stderr,
      });
    },
  };

  // `mcp-tools` was a top-level command until it moved under
  // `experimental`. The old spelling fails with the new one instead of
  // yargs' bare "Unknown argument", so a script written against the old
  // name says what to change. Hidden from the help: it runs nothing.
  const movedMcpToolsCommand: CommandModule = {
    command: "mcp-tools",
    describe: false,
    builder: (y: Argv) => y.strict(false).parserConfiguration({ "populate--": true }),
    handler: () => {
      if (argsFailed) return;
      exitCode = 1;
      stderr.write("`nuka mcp-tools` moved to `nuka experimental mcp-tools`; run that instead, with the same arguments\n");
    },
  };

  const experimentalCommand: CommandModule = {
    command: "experimental",
    describe:
      "EXPERIMENTAL: commands this package is still trying out; any of them may change shape or " +
      "disappear release to release without the deprecation notice a stable command would get",
    builder: (y: Argv) => y.command(mcpToolsCommand).command(webmcpToolsCommand).demandCommand(1).strict(),
    handler: () => {
      // Never invoked: `demandCommand(1)` on the sub-builder above requires
      // `mcp-tools` or `webmcp-tools`, same pattern as `skillCommand`/`sessionCommand`.
    },
  };

  const sessionCommand: CommandModule = {
    command: "session",
    describe: "list|clear|start|stop sessions",
    builder: (y: Argv) =>
      y
        .command(sessionListCommand)
        .command(sessionClearCommand)
        .command(sessionStartCommand)
        .command(sessionStopCommand)
        .demandCommand(1)
        .strict(),
    handler: () => {
      // Never invoked: `demandCommand(1)` on the sub-builder above requires
      // one of `list`/`clear`/`start`/`stop`, so this bare handler only
      // exists to satisfy yargs' CommandModule shape.
    },
  };

  // The order a newcomer meets them in: the everyday loop first, then the
  // commands for exploring a path one step at a time, then upkeep.
  const helpGroups: HelpGroup[] = [
    {
      heading: "Everyday",
      commands: [initCommand, scaffoldCommand, checkCommand, runCommand, stepsCommand, describeCommand],
    },
    { heading: "Exploring", commands: [doCommand, sessionCommand, harvestCommand, exploreCommand] },
    { heading: "Upkeep", commands: [tendCommand, cleanCommand, skillCommand] },
    { heading: "Experimental", commands: [experimentalCommand] },
  ];

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
      exitCode = 1;
      stderr.write(`${err instanceof Error ? err.message : (msg ?? "unknown error")}\n`);
    })
    .usage(
      `nuka <command>\n\n${renderCommandGroups(
        "nuka",
        helpGroups.map((group) => ({ heading: group.heading, lines: helpLines(group) })),
        HELP_WIDTH,
      )}`,
    )
    .wrap(null)
    .command(movedMcpToolsCommand)
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
  return exitCode;
}
