import yargs from "yargs";
// TODO(types): @types/yargs is pinned to the 17.x line (no 18.x types on
// DefinitelyTyped yet); CommandModule/Argv here
// are the 17.x shapes. yargs 18's runtime behavior used below (command
// builders, .fail(), parseAsync()) is unchanged from 17, so this is a type
// approximation, not a behavior mismatch.
import type { Arguments, Argv, CommandModule } from "yargs";
import { readOwnVersion } from "../version.js";
import { AGENT_ENTRY_POINT, HELP_WIDTH, type HelpGroup, helpLines, renderCommandGroups, withoutFlatListing } from "./help-groups.js";
import { commandTookTheName, VALID_STEP_NAME } from "./option-defaults.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { shellWord } from "../shell/shell-word.js";
import { DEFAULT_PROOF_RUNS } from "../condition/condition.js";
import { formatFinding, type Finding } from "../finding/finding.js";
import {
  REFUSED_EXIT_CODE,
  RefusalError,
  commandPathOf,
  configMissingFinding,
  failInShape,
  formatEnvelope,
  refusalOf,
  refuse,
  withHint,
  writeStopped,
} from "./refusal.js";

// Responsibility: wires the commands (`steps`, `describe`, `do`, `run`,
// `init`, `scaffold`, `check`, `clean`, `skill path`)
// to yargs and turns any failure — yargs' own (bad flags, no command) or
// ours (config/discovery errors, unknown step name) — into stderr output
// plus a non-zero exit code, without ever calling `process.exit` itself.
// That is `cli.ts`'s job, so this function stays callable directly from
// tests. `do`'s own setup/execution split and step record writing lives in
// cli/do.ts; `run`'s own execution lives in cli/run.ts; `init`/`scaffold`'s own generation logic lives in
// cli/init.ts and
// cli/scaffold.ts; `check`'s own analysis lives in cli/check.ts (thin
// wiring) and src/check/* (the actual checks); `clean`'s own plan-then-
// delete logic lives entirely in cli/clean.ts (see that file's own header
// for why it stays self-contained rather than sharing path helpers with
// cli/do.ts/cli/run.ts); `skill`'s own path resolution logic lives in cli/skill.ts
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
// command made `nuka --version` load the run engine, the report writers,
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
  env?: string;
  /** `--use <record-id>` (repeatable) — yargs' `array: true` collects
   * every occurrence into this list, in the order given, rather than only
   * keeping the last one. */
  use?: string[];
}

interface RunArgs {
  feature?: string[];
  /** `--base <git ref>`: compare with the commit the ref names, and add
   * the base and the old world (docs/spec.md "Verdicts"). */
  base?: string;
  /** `false` under `--no-check` (yargs' own boolean negation). */
  check?: boolean;
  /** `--env`: one name, or every name when the flag repeats (yargs-parser
   * collects a repeated string flag into an array). Not `array: true`,
   * which would also swallow the feature targets that follow it. */
  env?: string | string[];
  /** Writes run.json's scenario entries to stdout, one per line; without
   * it stdout stays empty. */
  records?: boolean;
  /** Prints run.json on stdout instead of the scenario entry stream. */
  json?: boolean;
  /** Same `NaN`/fraction caveat as `concurrency` below; run.ts refuses
   * anything but a whole number of 1 or more. */
  repeat?: number;
  /** Same caveat as `repeat`; run.ts refuses anything but a whole number
   * of 1 or more. */
  "proof-runs"?: number;
  /** yargs' own `type: "number"` accepts `NaN`/a fraction without
   * complaint; run.ts's own setup phase is what actually refuses either
   * (that file's own header explains why the check lives there and not
   * here). */
  concurrency?: number;
}

interface InitArgs {
  allure?: boolean;
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
  /** `--fail-on`; yargs collects a repeated flag into an array. */
  "fail-on"?: string[];
  /** `--env`, a string once and an array when repeated. */
  env?: string | string[];
}

interface CleanArgs {
  dryRun?: boolean;
  json?: boolean;
}

interface ReportArgs {
  run?: string;
  format?: string;
  out?: string;
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
  "nuka clean always removes records and export together; nuka clean --dry-run lists what it would remove.";

// A removed flag is refused by name, with what replaces it, rather than
// left to `.strict()`: "Unknown argument: session" says what is wrong with
// an older command but not what to write instead. Hidden, so --help lists
// only what works. The message names the replacement, so the refusal has a
// `fix`, and a `do` only where the flag's own value makes one command the
// next step (`--since <ref>` is `--base <ref>`): otherwise no one command is
// right for every caller, and a placeholder such as the command's help
// would read as one.
const REMOVED_FIX = "Use what the message names in its place.";

interface RemovedFlag {
  readonly message: string;
  /** The command that replaces the flag, from the value it was given. */
  readonly do?: (value: unknown) => string | undefined;
}

function refuseRemovedFlags(y: Argv, removed: Readonly<Record<string, string | RemovedFlag>>): Argv {
  const withOptions = Object.keys(removed).reduce((acc, flag) => acc.option(flag, { hidden: true }), y);
  return withOptions.check((args) => {
    const record = args as unknown as Record<string, unknown>;
    for (const [flag, entry] of Object.entries(removed)) {
      if (record[flag] === undefined) continue;
      const { message, do: replacement } = typeof entry === "string" ? { message: entry, do: undefined } : entry;
      const command = replacement?.(record[flag]);
      throw new RefusalError("removed-flag", message, { fix: REMOVED_FIX, ...(command === undefined ? {} : { do: command }) });
    }
    return true;
  });
}

function firstWord(command: string | readonly string[] | undefined): string {
  const text = typeof command === "string" ? command : (command?.[0] ?? "");
  return text.split(" ")[0] ?? "";
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
  // may perform real side effects (writing a step record, deleting runs),
  // so letting it run would silence the failure and let an unparsed
  // invocation take real action. `argsFailed` is set synchronously inside
  // `.fail()`, which — because validation always runs before dispatch, see
  // yargs' `handleValidationAndGetResult` — is guaranteed to be set before
  // any handler below reads it. Each handler checks it first and returns
  // immediately, before doing anything else, so a failed parse has zero
  // side effects.
  let argsFailed = false;
  // One refused finding per failure of the parse, each with its own code.
  const usageFailures: Finding[] = [];
  // Read after the parser is built, since the command names come from it.
  const usageCommand = (): string => commandPathOf(argv, commandNames);
  const jsonRequested = argv.includes("--json");
  // Findings raised before a command runs, such as a missing config file.
  // Text writes them to stderr at once; `--json` hands them to the command,
  // which puts them in its one document.
  let notices: Finding[] = [];

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
        if (line !== null) {
          const finding = configMissingFinding(line);
          // `describe` and `do` print a document of their own whatever the
          // flags say, so a notice cannot wait for a `--json` that is not there.
          const held = (args as { json?: unknown }).json === true || command.command === "describe <name>";
          if (held) notices = [finding];
          else stderr.write(formatFinding(withHint(finding)));
        }
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
          contractFindings,
          importFailureFindings,
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
        // reasoning `nuka check` already acts on. `run`/`do`/
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
          const incomplete = importFailures.length > 0 || summaries.some((s) => s.needs_error !== undefined || s.from_errors !== undefined);
          stdout.write(
            formatEnvelope("steps", incomplete ? 1 : 0, [...notices, ...importFailureFindings(rootDir, importFailureSummaries), ...contractFindings(summaries)], {
              steps: summaries,
            }),
          );
        } else {
          // A fixed width, not the terminal's: the same project prints the
          // same text in a terminal, a pipe, and an agent's shell.
          stdout.write(formatVocabulary(summaries, 80));
          for (const finding of importFailureFindings(rootDir, importFailureSummaries)) stderr.write(formatFinding(finding));
        }
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
        exitCode = refuse({ json: args.json ?? false, stdout, stderr, command: "steps" }, error, "unexpected-error", undefined, notices);
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
          contractFindings,
          importFailureFindings,
          loadVocabulary,
          toImportFailureSummaries,
        },
      ] = await Promise.all([
        import("../fixture/graph.js"),
        import("./vocabulary.js"),
      ]);
      // `describe` has no text form: its stdout is always one JSON object,
      // so a refusal is one too.
      const sinks = { json: true, stdout, stderr, command: "describe" };
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
          // The step asked about may be the one whose file did not import,
          // so the import failures go in the same document.
          exitCode = refuse(sinks, `Unknown step: ${args.name}`, "unknown-step", { do: "nuka steps" }, [
            ...notices,
            ...importFailureFindings(rootDir, importFailureSummaries),
          ]);
          return;
        }
        // Same `buildFixtureGraph(config)` call `steps` above already makes
        // — `describeContract`'s own `needs`/`needs_browser` need it for the
        // same reason `summarize`'s do (that field's own doc comment):
        // without it, `describe`'s "full contract" would fall back to a
        // builtins-only guess instead of this project's real fixture graph.
        const graph = buildFixtureGraph(config);
        const contract = describeContract(entry, buildStepNames(vocabulary), rootDir, graph);
        // The document's `import_failures` is the one copy: stdout is always
        // JSON here, so a stderr listing would only say it twice.
        const incomplete =
          importFailures.length > 0 ||
          (contract.kind === "typed" &&
            (contract.from_errors !== undefined ||
              contract.needs_error !== undefined ||
              contract.args_error !== undefined ||
              contract.returns_error !== undefined));
        stdout.write(
          formatEnvelope(
            "describe",
            incomplete ? 1 : 0,
            [...notices, ...importFailureFindings(rootDir, importFailureSummaries), ...(contract.kind === "typed" ? contractFindings([contract]) : [])],
            { ...contract },
          ),
        );
        // Same rule as `steps` above, scoped to this one contract: an
        // import failure elsewhere in the project, this step's own
        // unreadable `from` entry (`from_errors`), this step's own
        // unreadable `needs` (`needs_error`), or an args/returns schema
        // JSON Schema cannot represent (`args_error` / `returns_error`).
        // Same reasoning in every case: the output went ahead and printed,
        // but it is not complete.
        if (incomplete) exitCode = 1;
      } catch (error) {
        exitCode = refuse(sinks, error, "unexpected-error", undefined, notices);
      }
    },
  };

  const doCommand: CommandModule<Record<string, never>, DoArgs> = {
    command: "do <name>",
    describe: "execute one typed step; step record to stdout",
    builder: (y: Argv) =>
      refuseRemovedFlags(y, {
        session:
          "nuka do --session is removed: each nuka do call starts clean. A step that needs login state gets it from " +
          "a fixture, and a page whose state cannot be repeated is explored through a Playwright MCP server.",
      })
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
        .option("env", {
          type: "string",
          describe:
            'target a named environment (omit it, or name "default", for the "default" environment: the top-level ' +
            "settings, or environments.default when nukadoko.program.ts defines it)",
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
        .check(rejectRepeatedFlags(["args", "env"])) as Argv<DoArgs>,
    handler: async (args: Arguments<DoArgs>) => {
      if (argsFailed) return;
      const { runDo } = await import("./do.js");
      exitCode = await runDo({
        rootDir,
        name: args.name,
        argsJson: args.args ?? null,
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
      "check, then execute scenarios from a feature file or a directory of them (featuresDir when none is given); step records + run.json",
    builder: (y: Argv) =>
      refuseRemovedFlags(y, {
        session:
          "nuka run --session is removed: a scenario that needs login state gets it from a fixture or a Given step " +
          "its feature names.",
        quiet:
          "nuka run --quiet is removed: nuka run --json prints one document on stdout and nothing on stderr.",
        summary:
          "nuka run --summary is removed: nuka report --format markdown --out <path> writes the run summary of the " +
          "newest run to a path.",
        probe:
          "nuka run --probe is removed: a Then is judged from its step record and its step file, not from a second run " +
          "with a changed value.",
        since: {
          message:
            "nuka run --since is removed: nuka run --base <ref> compares with the commit the ref names, runs a new or " +
            "changed scenario where the base's code runs, and an unchanged one under the base's steps when they changed, " +
            "and the verdict table says what each criterion came to.",
          // yargs reads an all-digit hash as a number.
          do: (value) => (typeof value === "string" || typeof value === "number") && String(value).length > 0 ? `nuka run --base ${shellWord(String(value))}` : undefined,
        },
      })
        .positional("feature", {
          type: "string",
          array: true,
          describe:
            "feature file, optionally with :line (e.g. features/checkout.feature:12), or a directory " +
            "walked recursively for .feature files (:line is refused on a directory); omit to run featuresDir",
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
          describe:
            "target a named environment from nukadoko.program.ts; repeat it to run every selected scenario once in each, " +
            "in one run with one cell per scenario and environment. Omitted, the run selects every environment that declares " +
            'conditions, or the "default" environment (the top-level settings, or environments.default) when none does',
        })
        .option("records", {
          type: "boolean",
          default: false,
          describe:
            "write each scenario's run.json entry to stdout as one JSON line, as the scenario finishes " +
            "(without it, stdout stays empty; run.json holds every entry either way). A step's program_log_late " +
            "is only in run.json, written when the world stops, after the scenario's line",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe:
            "print the run's result (run.json: run id, verdict, counts, each scenario's record and rerun command) " +
            "on stdout as one JSON document, and no progress, location, or count lines on stderr",
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
        .option("proof-runs", {
          type: "number",
          default: DEFAULT_PROOF_RUNS,
          describe:
            "run a control cell (a scenario in an environment that does not meet its @with:/@without: conditions) until " +
            "the same claim in Then has broken at the same line this many times, or a run disagrees (default 2); only then does " +
            "the control prove the scenario. A required cell runs once, or --repeat times",
        })
        .option("base", {
          type: "string",
          nargs: 1,
          describe:
            "compare each scenario with the commit a git ref names (the pull request's base): a new or changed scenario " +
            "also runs against the base's code, where a Then has to fail for it to be proven, and when the steps changed, " +
            "an unchanged one also runs under the base's steps, where it has to pass. The table gives each criterion its " +
            "change and one of held, proven, removed, failed, unproven, or moved, and the run fails on failed, unproven, " +
            "or moved. A shallow clone has to fetch the base first",
        })
        .check(rejectRepeatedFlags(["concurrency", "repeat", "proof-runs", "base"])) as Argv<RunArgs>,
    handler: async (args: Arguments<RunArgs>) => {
      if (argsFailed) return;
      const { runRun } = await import("./run.js");
      exitCode = await runRun({
        notices,
        rootDir,
        featureArgs: args.feature ?? [],
        check: args.check ?? true,
        envs: args.env === undefined ? [] : typeof args.env === "string" ? [args.env] : args.env,
        records: args.records ?? false,
        json: args.json ?? false,
        concurrency: args.concurrency ?? 1,
        repeat: args.repeat ?? 1,
        proofRuns: args["proof-runs"] ?? DEFAULT_PROOF_RUNS,
        ...(args.base !== undefined ? { base: args.base } : {}),
        // GitHub Actions sets this for every step; an empty value means no
        // file to append to.
        stepSummaryPath: process.env.GITHUB_STEP_SUMMARY || undefined,
        stdout: await recordStdout(),
        stderr,
      });
    },
  };

  // `harvest`, `session`, `explore`, `experimental`, and `tend` were removed. Each
  // old spelling names what replaces it instead of yargs' bare "Unknown
  // argument", so a script that still calls it learns what to change.
  // Hidden from the help: they run nothing. A `fix` and no `do`, for the
  // reason `refuseRemovedFlags` gives. A fix that names the state
  // directory reads it from the config, when one loads.
  const removedCommand = (command: string, message: string, fixFor: (stateDir: string) => string): CommandModule => ({
    command,
    describe: false,
    builder: (y: Argv) => y.strict(false),
    handler: async () => {
      if (argsFailed) return;
      let stateDir = ".nukadoko";
      try {
        const { loadConfig } = await import("../config/load-config.js");
        stateDir = (await loadConfig(rootDir)).stateDir;
      } catch {
        // No config, or one that does not load: the default is still the
        // directory an earlier release wrote to.
      }
      exitCode = refuse({ json: jsonRequested, stdout, stderr, command }, message, "removed-command", { fix: fixFor(stateDir) });
    },
  });
  const removedHarvestCommand = removedCommand(
    "harvest",
    "`nuka harvest` was removed (see docs/upgrading.md in the nukadoko package)",
    () => "Write the scenario from the steps you ran in a feature file.",
  );
  const removedSessionCommand = removedCommand(
    "session",
    "`nuka session` was removed with sessions: each nuka do call starts clean, and a step that needs login state " +
      "gets it from a fixture (see docs/upgrading.md in the nukadoko package)",
    (stateDir) => `Give the step a fixture that logs in, and delete ${stateDir.replace(/\/+$/, "")}/cache/.`,
  );
  const removedExperimentalCommand = removedCommand(
    "experimental",
    "`nuka experimental explore` was removed with models and relations (see docs/upgrading.md in the nukadoko package)",
    () => "Write each sequence the model found as a scenario in a feature file.",
  );
  const removedExploreCommand = removedCommand(
    "explore",
    "`nuka explore` was removed with models and relations (see docs/upgrading.md in the nukadoko package)",
    () => "Write each sequence the model found as a scenario in a feature file.",
  );

  const removedTendCommand = removedCommand(
    "tend",
    "`nuka tend` was removed: `nuka check` reports its findings as notes, and `nuka check --fail-on <code>` " +
      "turns one into a failing exit (see docs/upgrading.md in the nukadoko package)",
    () => "Run nuka check, and add --fail-on <code> for each note a job gates on.",
  );

  const initCommand: CommandModule<Record<string, never>, InitArgs> = {
    command: "init",
    describe: "set up a project; ends with a self-check",
    builder: (y: Argv) =>
      refuseRemovedFlags(y, {
        "base-url":
          "nuka init --base-url is removed: write url in nukadoko.program.ts " +
          '(export default defineProgram({ url: "http://localhost:3000" })), the URL every page and request resolves against.',
        server:
          "nuka init --server is removed: describe the program in nukadoko.program.ts " +
          '(export default defineProgram({ serve: { command: "npm start" }, env: { PORT: "{port}" } })); ' +
          "nukadoko starts it once for each environment, on a port of its own, and stops it after the scenarios.",
        "server-url":
          "nuka init --server-url is removed: a program nukadoko starts gets its port from serve in nukadoko.program.ts, " +
          "and one it does not start is named by url there.",
        "features-dir":
          "nuka init --features-dir is removed: init creates features/steps; for another directory, " +
          "set featuresDir in the generated config after init and move steps/ there.",
        "env-files": `nuka init --env-files is removed: ${INIT_WRITES_ENV_LINES}`,
        env: `nuka init --env is removed: ${INIT_WRITES_ENV_LINES}`,
      })
        .option("allure", {
          type: "boolean",
          describe: "write allurerc.mjs and an empty <stateDir>/export/allure-results/ for nuka report --format allure",
        }) as Argv<InitArgs>,
    handler: async (args: Arguments<InitArgs>) => {
      if (argsFailed) return;
      const { runInit } = await import("./init.js");
      exitCode = await runInit({
        rootDir,
        allure: args.allure ?? false,
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
          describe: "a claim step for a Then line: claims in place of run, against a value the line states (a capture, the docstring, the table, or a word such as none); a line that states none is refused",
        })
        .option("command", {
          type: "string",
          describe:
            "[entry point] a When step that runs a program in scratch.dir() (or in --cwd's directory) and returns exitCode, stdout, and stderr; the entry point must be an existing file and is written into the file, or left as a TODO the step refuses to run with",
        })
        .option("description", {
          type: "string",
          nargs: 1,
          describe: "what the step does, written as its description; without it --command and --request write one of what they generate, and any other form writes a TODO that nuka check reports as step-description-todo",
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
      "static checks: pattern/schema mismatches, claim steps and where they are bound, undefined steps per feature, duplicate patterns, config coherence, and notes on unused declarations",
    builder: (y: Argv) =>
      y
        .positional("feature", {
          type: "string",
          array: true,
          describe:
            "feature file or directory, selected the way nuka run selects them (no :line); " +
            "omit to check every feature under featuresDir and additionalFeatureDirs",
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
            "exit 1 when a finding with this code is reported (repeatable, or comma-separated); the finding keeps " +
            "its severity in the output, only the exit code changes. For a job that gates on one note, such as " +
            "pattern-unbound",
        })
        .option("codes", {
          type: "boolean",
          default: false,
          describe:
            "list every finding code nuka check can produce, with a one-line description, instead of checking a project",
        })
        .option("env", {
          type: "string",
          describe:
            "check as a nuka run with the same --env flags would run (repeatable): the placeholders of the worlds it " +
            "would start, and no other world's, and the condition tags read against its environments; omitted, every " +
            "environment that declares conditions, or default when none does",
        }) as Argv<CheckArgs>,
    handler: async (args: Arguments<CheckArgs>) => {
      if (argsFailed) return;
      const { runCheck } = await import("./check.js");
      exitCode = await runCheck({
        notices,
        rootDir,
        json: args.json ?? false,
        codes: args.codes ?? false,
        targets: args.feature ?? [],
        envs: args.env === undefined ? [] : typeof args.env === "string" ? [args.env] : args.env,
        failOn: (args["fail-on"] ?? []).flatMap((value) => value.split(",")).map((code) => code.trim()).filter((code) => code.length > 0),
        stdout,
        stderr,
      });
    },
  };

  const cleanCommand: CommandModule<Record<string, never>, CleanArgs> = {
    command: "clean",
    describe:
      "delete accumulated runs, do records, what nuka report wrote under export/ (the files a run's manifest names and the contents of allure-results; every other file stays), " +
      "and the cache/ and records/ directories earlier releases left, in the state directory",
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
        notices,
        rootDir,
        dryRun: args.dryRun ?? false,
        json: args.json ?? false,
        stdout,
        stderr,
      });
    },
  };

  const reportCommand: CommandModule<Record<string, never>, ReportArgs> = {
    command: "report [run]",
    describe: "render a finished run as Markdown, Allure results, or a cucumber-messages stream, from its run directory alone",
    builder: (y: Argv) =>
      y
        .positional("run", {
          type: "string",
          describe: "a run directory (the newest run under the state directory when omitted); a copy taken off another machine renders the same",
        })
        .option("format", {
          type: "string",
          choices: ["markdown", "allure", "messages"],
          demandOption: true,
          describe: "markdown: the run summary; allure: an allure-results directory; messages: a cucumber-messages NDJSON stream",
        })
        .option("out", {
          type: "string",
          nargs: 1,
          describe:
            "where to write: a file for markdown and messages (stdout without it), a directory for allure " +
            "(<stateDir>/export/allure-results without it); a missing directory on the way is created, and " +
            "anything else in the way (a directory where a file goes, a FIFO, a dangling link, a file above it, the Allure history file) " +
            "or a markdown or messages file the file system refuses to write is refused with report-out-invalid",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "print the result (run id, format, what was written) as one JSON document; needs --out for markdown and messages",
        })
        .check(rejectRepeatedFlags(["format", "out"])) as Argv<ReportArgs>,
    handler: async (args: Arguments<ReportArgs>) => {
      if (argsFailed) return;
      const { runReport } = await import("./report.js");
      exitCode = await runReport({
        notices,
        rootDir,
        runDir: args.run,
        format: args.format as "markdown" | "allure" | "messages",
        out: args.out,
        json: args.json ?? false,
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
      // `path`.
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
        namingMissingConfig(reportCommand),
        namingMissingConfig(stepsCommand),
        namingMissingConfig(describeCommand),
      ],
    },
    {
      heading: "Exploring",
      commands: [namingMissingConfig(doCommand)],
    },
    { heading: "Upkeep", commands: [namingMissingConfig(cleanCommand), skillCommand] },
  ];

  const commandNames = new Map<string, readonly string[]>(
    helpGroups
      .flatMap((group) => group.commands)
      .concat(removedHarvestCommand, removedSessionCommand, removedExperimentalCommand, removedExploreCommand, removedTendCommand)
      .map((command) => [firstWord(command.command), []]),
  );
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
        exitCode = failInShape({ json: jsonRequested, stdout, stderr, command: usageCommand() }, err, "unexpected-error");
        return;
      }
      // Anything else is the invocation itself: an unknown flag or command,
      // a missing argument, or a `.check()` that refused. One parse can fail
      // more than once (a missing name, then why it is missing), and all of
      // them become findings of one envelope after the parse. yargs joins
      // those reasons with a newline, and a finding's message is one line.
      const reason = msg === null ? undefined : msg.split("\n").filter((part) => part !== "").join("; ");
      const cause = err instanceof RefusalError ? err : (reason ?? err ?? "unknown error");
      usageFailures.push(refusalOf(cause, "invalid-arguments", usageCommand()));
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
    .command(removedSessionCommand)
    .command(removedExperimentalCommand)
    .command(removedExploreCommand)
    .command(removedTendCommand)
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
      exitCode = failInShape({ json: jsonRequested, stdout, stderr, command: usageCommand() }, error, "unexpected-error");
    }
  }
  if (usageFailures.length > 0) {
    exitCode = writeStopped({ json: jsonRequested, stdout, stderr, command: usageCommand() }, usageFailures, REFUSED_EXIT_CODE);
  }
  return exitCode;
}
