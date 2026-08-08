import yargs from "yargs";
// TODO(types): @types/yargs is pinned to the 17.x line (no 18.x types on
// DefinitelyTyped yet per the task's constraints); CommandModule/Argv here
// are the 17.x shapes. yargs 18's runtime behavior used below (command
// builders, .fail(), parseAsync()) is unchanged from 17, so this is a type
// approximation, not a behavior mismatch.
import type { Arguments, Argv, CommandModule } from "yargs";
import { buildFixtureGraph } from "../fixture/graph.js";
import { readOwnVersion } from "../version.js";
import { runAccept } from "./accept.js";
import { runCheck } from "./check.js";
import { runDo } from "./do.js";
import { runInit } from "./init.js";
import { runRun } from "./run.js";
import { runScaffold } from "./scaffold.js";
import { runSessionClear, runSessionList } from "./session.js";
import { runSkillPath } from "./skill.js";
import { runTend } from "./tend.js";
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
import type { WritableSink } from "./writable-sink.js";

// Responsibility: wires the commands this slice ships (`steps`, `describe`,
// `do`, `session list`/`clear`, `init`, `scaffold`, `check`, `tend`,
// `accept`, `skill path`) to yargs and turns any failure — yargs' own (bad
// flags, no command) or ours (config/discovery errors, unknown step name) —
// into stderr output plus a non-zero exit code, without ever calling
// `process.exit` itself. That is `cli.ts`'s job, so this function stays
// callable directly from tests. `do`'s own setup/execution split and
// receipt writing lives in cli/do.ts; `session`'s own list/clear logic
// lives in cli/session.ts; `init`/`scaffold`'s own generation logic lives
// in cli/init.ts and cli/scaffold.ts; `check`'s own analysis lives in
// cli/check.ts (thin wiring) and src/check/* (the actual checks); `tend`'s
// own analysis lives in cli/tend.ts (thin wiring) and src/tend/* (the
// actual findings) — the same split, one command answering "can this run",
// the other "is this still healthy" (docs/spec.md "Tending"); `accept`'s
// own run-selection and record-rendering logic lives in cli/accept.ts and
// src/accept/* (m4b-accept task spec), the same split; `skill`'s own path
// resolution logic lives in cli/skill.ts (m5a-acceptance-skill task spec,
// `install` removed in m5e-skill-spec-compliance — see that file's header),
// the same split; this module only wires their argv shapes and reports
// their exit codes.
//
// `--version` (own-version task spec) reads nukadoko's own package.json via
// src/version.ts's readOwnVersion() and is fed to yargs' `.version()`
// explicitly, below — yargs was never told a version before, so it fell
// back to its own default resolution, which walks up from `process.cwd()`
// and prints whichever project happens to be running the CLI, not
// nukadoko's own. If reading nukadoko's own version fails, that is a
// packaging bug (see readOwnVersion()'s own doc comment): the whole
// invocation fails fast, before yargs even parses `argv`, rather than
// falling through to a wrong or guessed version string.

export type { WritableSink } from "./writable-sink.js";

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
  /** Optional only when `--use` is also given (fb4-args-optional task
   * spec) — `doCommand`'s own `.check()` below enforces that at least one
   * of the two is present; the handler defaults a missing `args` to
   * `"{}"` so `--use`'s `from` injection (do.ts, execution phase) still has
   * an object to fill. */
  args?: string;
  session?: string;
  env?: string;
  /** `--use <receipt-id>` (repeatable, m6c-do-use task spec) — yargs'
   * `array: true` collects every occurrence into this list, in the order
   * given, rather than only keeping the last one. */
  use?: string[];
}

interface RunArgs {
  feature: string;
  session?: string;
  env?: string;
  /** Suppresses the per-step/per-scenario progress lines (fb5-run-output
   * task spec, decision 4) — the output-location and summary lines still
   * print; run.ts's own header explains why those two are exempt. */
  quiet?: boolean;
}

interface SessionListArgs {
  json?: boolean;
}

interface SessionClearArgs {
  name?: string;
  env: string;
}

interface InitArgs {
  baseUrl?: string;
  featuresDir?: string;
}

interface ScaffoldArgs {
  name: string;
}

interface CheckArgs {
  json?: boolean;
  feature?: string;
}

interface TendArgs {
  json?: boolean;
}

interface AcceptArgs {
  feature: string;
  env?: string;
}

type SkillPathArgs = Record<string, never>;

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const rootDir = options.rootDir ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

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
  // may perform real side effects (writing a receipt, clearing a session),
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
        // Tolerant (fb5-loader-visibility task spec, decision 1): `steps` is
        // a reporting tool, not something about to execute a step, so one
        // broken glue file elsewhere must not empty everything else it could
        // still read — the same migrating-suite reasoning `nuka check`/
        // `nuka tend` already act on. `run`/`do`/`init` deliberately do not
        // pass this (they stay fail-fast).
        const { vocabulary, config, importFailures } = await loadVocabulary(rootDir, {
          tolerateImportFailures: true,
        });
        // `nuka check`'s own `features-dir-missing` condition (cli-messages-
        // name-the-cause task spec, item 1): discovery itself treats a
        // missing featuresDir as an empty vocabulary, so this call is what
        // keeps that leniency from reading, on stdout, as indistinguishable
        // from a real project that simply has no steps yet. Thrown before
        // any stdout.write below, so a failure here never leaves a partial
        // or misleading `--json` payload behind.
        assertFeaturesDirExists(rootDir, config);
        const stepNames = buildStepNames(vocabulary);
        const graph = buildFixtureGraph(config);
        const summaries = [...vocabulary.values()].map((entry) => summarize(entry, stepNames, graph));
        const importFailureSummaries = toImportFailureSummaries(importFailures);
        if (args.json) {
          // Top-level shape change from a bare array to `{ steps,
          // import_failures }` (fb5-loader-visibility task spec, decision 1)
          // — 0.x accepts the break; the alternative, silently dropping
          // `import_failures` off a bare array, is exactly the "machine
          // reader treats an incomplete list as complete" failure this field
          // exists to prevent.
          stdout.write(
            `${JSON.stringify({ steps: summaries, import_failures: importFailureSummaries }, null, 2)}\n`,
          );
        } else {
          // `stdout` here is the injected `WritableSink` (real process
          // stdout by default, a capture sink in tests), which has no
          // notion of terminal width; `process.stdout.columns` is read
          // directly instead, falling back to 80 for a non-TTY or a test run
          // (steps-human-output task spec).
          stdout.write(formatVocabulary(summaries, process.stdout.columns ?? 80));
        }
        stderr.write(formatImportFailuresStderr(importFailureSummaries));
        // Exit 1 whenever the output is incomplete in a way this command
        // still went ahead and printed anyway (fb5-loader-visibility task
        // spec, decisions 1 and 2): an import failure, or a step whose own
        // `needs` this run couldn't read (`summarize`'s own `needs_error`).
        // Output is not withheld either way — only "this succeeded" is.
        if (importFailures.length > 0 || summaries.some((s) => s.needs_error !== undefined)) {
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
        // Same tolerant mode as `steps` above, same reasoning (fb5-loader-
        // visibility task spec, decision 1) — also the one case where it
        // matters most: the step this call is asking about may be exactly
        // the one whose own file failed to import, so "Unknown step" alone
        // would misdiagnose a migration problem as a typo.
        const { vocabulary, importFailures } = await loadVocabulary(rootDir, {
          tolerateImportFailures: true,
        });
        const importFailureSummaries = toImportFailureSummaries(importFailures);
        const entry = vocabulary.get(args.name);
        if (!entry) {
          exitCode = 1;
          stderr.write(`Unknown step: ${args.name}\n`);
          stderr.write(formatImportFailuresStderr(importFailureSummaries));
          return;
        }
        const contract = describeContract(entry, buildStepNames(vocabulary));
        stdout.write(
          `${JSON.stringify({ ...contract, import_failures: importFailureSummaries }, null, 2)}\n`,
        );
        stderr.write(formatImportFailuresStderr(importFailureSummaries));
        if (importFailures.length > 0) {
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
    describe: "execute one typed step; receipt to stdout",
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
            "receipt id whose result fills this step's `from` keys (repeatable; --args still wins for a key it also sets)",
        })
        // `--args` lost its `demandOption` (fb4-args-optional task spec):
        // once `--use` is given, "arguments come from the chain" is already
        // stated, so making the caller also write `--args '{}'` for a step
        // every key of which `from` fills is pure ritual. This `.check()`
        // is what still refuses the case that matters — neither flag given
        // — kept in the same yargs layer `demandOption` used to occupy
        // (not moved into do.ts) so a bad invocation still fails before any
        // receipt-writing setup runs, exactly as it did before.
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
        }) as Argv<DoArgs>,
    handler: async (args: Arguments<DoArgs>) => {
      if (argsFailed) return;
      exitCode = await runDo({
        rootDir,
        name: args.name,
        // `--args`'s own `.check()` above already refused this when both
        // it and `--use` are absent, so `??` here only ever fires when
        // `--use` supplies this step's arguments (fb4-args-optional task
        // spec) — `"{}"` gives do.ts's `from` injection (execution phase)
        // an object to fill.
        argsJson: args.args ?? "{}",
        session: args.session ?? null,
        env: args.env ?? null,
        use: args.use ?? [],
        stdout,
        stderr,
      });
    },
  };

  const runCommand: CommandModule<Record<string, never>, RunArgs> = {
    command: "run <feature>",
    describe: "execute scenarios from a feature file or a directory of them; receipts + scenario records",
    builder: (y: Argv) =>
      y
        .positional("feature", {
          type: "string",
          demandOption: true,
          describe:
            "feature file path, optionally with :line (e.g. features/checkout.feature:12), or a directory " +
            "walked recursively for .feature files (:line is refused on a directory)",
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
        }) as Argv<RunArgs>,
    handler: async (args: Arguments<RunArgs>) => {
      if (argsFailed) return;
      exitCode = await runRun({
        rootDir,
        featureArg: args.feature,
        session: args.session ?? null,
        env: args.env ?? null,
        quiet: args.quiet ?? false,
        stdout,
        stderr,
      });
    },
  };

  const sessionListCommand: CommandModule<Record<string, never>, SessionListArgs> = {
    command: "list",
    describe: "list sessions for the default environment",
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
          default: "default",
          describe: "environment to clear sessions from",
        }) as Argv<SessionClearArgs>,
    handler: async (args: Arguments<SessionClearArgs>) => {
      if (argsFailed) return;
      exitCode = await runSessionClear({
        rootDir,
        name: args.name ?? null,
        environment: args.env,
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
        }) as Argv<InitArgs>,
    handler: async (args: Arguments<InitArgs>) => {
      if (argsFailed) return;
      exitCode = await runInit({
        rootDir,
        baseUrl: args.baseUrl ?? null,
        featuresDir: args.featuresDir ?? null,
        stdout,
        stderr,
      });
    },
  };

  const scaffoldCommand: CommandModule<Record<string, never>, ScaffoldArgs> = {
    command: "scaffold <name>",
    describe: "typed step template that fails until implemented",
    builder: (y: Argv) =>
      y.positional("name", {
        type: "string",
        demandOption: true,
        describe: "step name, kebab-case (becomes the step's file name)",
      }) as Argv<ScaffoldArgs>,
    handler: async (args: Arguments<ScaffoldArgs>) => {
      if (argsFailed) return;
      exitCode = await runScaffold({
        rootDir,
        name: args.name,
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
            "check only this feature file instead of every feature under featuresDir (no :line)",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "machine-readable output",
        }) as Argv<CheckArgs>,
    handler: async (args: Arguments<CheckArgs>) => {
      if (argsFailed) return;
      exitCode = await runCheck({
        rootDir,
        json: args.json ?? false,
        featureArg: args.feature,
        stdout,
        stderr,
      });
    },
  };

  const tendCommand: CommandModule<Record<string, never>, TendArgs> = {
    command: "tend",
    describe: "what is rotting rather than what is broken: unused declarations, undescribed fields, missing rationale",
    builder: (y: Argv) =>
      y.option("json", {
        type: "boolean",
        default: false,
        describe: "machine-readable output",
      }) as Argv<TendArgs>,
    handler: async (args: Arguments<TendArgs>) => {
      if (argsFailed) return;
      exitCode = await runTend({
        rootDir,
        json: args.json ?? false,
        stdout,
        stderr,
      });
    },
  };

  const acceptCommand: CommandModule<Record<string, never>, AcceptArgs> = {
    command: "accept <feature>",
    describe: "freeze that feature's last green run as a committed acceptance record beside it",
    builder: (y: Argv) =>
      y
        .positional("feature", {
          type: "string",
          demandOption: true,
          describe: "feature file path (no :line; only a whole-feature run can be accepted)",
        })
        .option("env", {
          type: "string",
          describe: 'target a named environment (omit for the "default" environment)',
        }) as Argv<AcceptArgs>,
    handler: async (args: Arguments<AcceptArgs>) => {
      if (argsFailed) return;
      exitCode = await runAccept({
        rootDir,
        featureArg: args.feature,
        env: args.env ?? null,
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

  const sessionCommand: CommandModule = {
    command: "session",
    describe: "list|clear sessions",
    builder: (y: Argv) =>
      y.command(sessionListCommand).command(sessionClearCommand).demandCommand(1).strict(),
    handler: () => {
      // Never invoked: `demandCommand(1)` on the sub-builder above requires
      // one of `list`/`clear`, so this bare handler only exists to satisfy
      // yargs' CommandModule shape.
    },
  };

  const parser = yargs(argv)
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
    .command(stepsCommand)
    .command(describeCommand)
    .command(doCommand)
    .command(runCommand)
    .command(sessionCommand)
    .command(initCommand)
    .command(scaffoldCommand)
    .command(checkCommand)
    .command(tendCommand)
    .command(acceptCommand)
    .command(skillCommand)
    .demandCommand(1)
    .strict()
    .help();

  await parser.parseAsync();
  return exitCode;
}
