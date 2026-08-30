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
import { runClean } from "./clean.js";
import { runDo } from "./do.js";
import { runHarvest } from "./harvest.js";
import { runInit } from "./init.js";
import { runMcpTools } from "./mcp-tools.js";
import { runRun } from "./run.js";
import { runScaffold } from "./scaffold.js";
import { runSessionClear, runSessionList, runSessionStart, runSessionStop } from "./session.js";
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
import type { WritableSink } from "./writable-sink.js";

// Responsibility: wires the commands this slice ships (`steps`, `describe`,
// `do`, `session list`/`clear`/`start`/`stop`, `init`, `scaffold`, `check`,
// `clean`, `tend`, `accept`, `skill path`, `mcp-tools`, `experimental webmcp-tools`)
// to yargs and turns any failure — yargs' own (bad flags, no command) or
// ours (config/discovery errors, unknown step name) — into stderr output
// plus a non-zero exit code, without ever calling `process.exit` itself.
// That is `cli.ts`'s job, so this function stays callable directly from
// tests. `do`'s own setup/execution split and step record writing lives in
// cli/do.ts, including deciding whether `--session` reaches a live
// session's own process (src/live/daemon.ts) or builds a fresh `ctx` the
// way it always has; `session`'s own list/clear/start/stop logic lives in
// cli/session.ts; `init`/`scaffold`'s own generation logic lives in
// cli/init.ts and
// cli/scaffold.ts; `check`'s own analysis lives in cli/check.ts (thin
// wiring) and src/check/* (the actual checks); `clean`'s own plan-then-
// delete logic lives entirely in cli/clean.ts (see that file's own header
// for why it stays self-contained rather than sharing path helpers with
// cli/do.ts/cli/run.ts); `tend`'s own analysis lives
// in cli/tend.ts (thin wiring) and src/tend/* (the actual findings) — the
// same split, one command answering "can this run", the other "is this
// still healthy" (docs/spec.md "Tending"); `accept`'s own run-selection and
// record-rendering logic lives in cli/accept.ts and src/accept/*, the same
// split; `skill`'s own path resolution logic lives in cli/skill.ts
// (`install` removed — see that file's header), the same split;
// `experimental webmcp-tools`'s own browser launch and tool-reading logic
// lives in cli/webmcp.ts (thin wiring) and src/webmcp/list-tools.ts (the
// actual work), nested one command under `experimental` rather than a
// top-level command so the word is unavoidable at every call site;
// `mcp-tools`'s own connect-list-close logic lives in cli/mcp-tools.ts
// (thin wiring, reaching src/mcp/list-tools.ts through a dynamic
// `import()` rather than a static one — that file's own header explains
// why) and stays a top-level command, unlike `webmcp-tools`: MCP is the
// protocol this whole surface is named after, not an auxiliary one
// (docs/spec.md "MCP servers"); `harvest`'s own draft-rendering and
// round-trip logic lives in cli/harvest.ts (thin wiring) and
// src/harvest/* (the actual work), the same split as `check`/`tend`/
// `accept`; this module only wires their argv shapes and reports their
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
  feature: string;
  session?: string;
  env?: string;
  /** Suppresses the per-step/per-scenario progress lines — the
   * output-location and summary lines still print; run.ts's own header
   * explains why those two are exempt. */
  quiet?: boolean;
  /** yargs' own `type: "number"` accepts `NaN`/a fraction without
   * complaint; run.ts's own setup phase is what actually refuses either
   * (that file's own header explains why the check lives there and not
   * here). */
  concurrency?: number;
}

interface HarvestArgs {
  /** yargs' own `<name..>` variadic positional syntax collects every
   * positional token into this array, in the order given on the command
   * line — `nuka harvest`'s own handler re-sorts them by each record's
   * `started_at` before rendering anything (docs/spec.md "Harvesting"). */
  stepRecordIds: string[];
}

interface SessionListArgs {
  json?: boolean;
}

interface SessionClearArgs {
  name?: string;
  env: string;
}

interface SessionStartArgs {
  name: string;
  env?: string;
  idleTimeout?: number;
}

interface SessionStopArgs {
  name: string;
  env?: string;
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
  codes?: boolean;
  feature?: string;
}

interface TendArgs {
  json?: boolean;
}

interface CleanArgs {
  dryRun?: boolean;
  records?: boolean;
  cache?: boolean;
  export?: boolean;
  json?: boolean;
}

interface AcceptArgs {
  feature: string;
  env?: string;
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
        // unreadable `from` entry (`from_errors`), or this step's own
        // unreadable `needs` (`needs_error`) — same reasoning in every
        // case, the output went ahead and printed, but it is not complete.
        if (
          importFailures.length > 0 ||
          (contract.kind === "typed" && (contract.from_errors !== undefined || contract.needs_error !== undefined))
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
        }) as Argv<DoArgs>,
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
        stdout,
        stderr,
      });
    },
  };

  const runCommand: CommandModule<Record<string, never>, RunArgs> = {
    command: "run <feature>",
    describe: "execute scenarios from a feature file or a directory of them; step records + scenario records",
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
        })
        .option("concurrency", {
          type: "number",
          default: 1,
          describe:
            "run n worker processes at once, one whole feature file per worker (default 1; has nothing to do " +
            "for a target naming one file, and drops back to 1 under --session)",
        }) as Argv<RunArgs>,
    handler: async (args: Arguments<RunArgs>) => {
      if (argsFailed) return;
      exitCode = await runRun({
        rootDir,
        featureArg: args.feature,
        session: args.session ?? null,
        env: args.env ?? null,
        quiet: args.quiet ?? false,
        concurrency: args.concurrency ?? 1,
        stdout,
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
          describe: "seconds of no execution before the session stops itself",
        }) as Argv<SessionStartArgs>,
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
        }) as Argv<SessionStopArgs>,
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
      "delete accumulated records/cache/export under the state directory; refuses while any session is live",
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

  const mcpToolsCommand: CommandModule<Record<string, never>, McpToolsArgs> = {
    command: "mcp-tools",
    describe:
      "list the tools an MCP server declares over stdio: `nuka mcp-tools -- <command> [args...]` " +
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

  const experimentalCommand: CommandModule = {
    command: "experimental",
    describe:
      "EXPERIMENTAL: commands this package is still trying out; any of them may change shape or " +
      "disappear release to release without the deprecation notice a stable command would get",
    builder: (y: Argv) => y.command(webmcpToolsCommand).demandCommand(1).strict(),
    handler: () => {
      // Never invoked: `demandCommand(1)` on the sub-builder above requires
      // `webmcp-tools`, same pattern as `skillCommand`/`sessionCommand`.
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
    .command(harvestCommand)
    .command(sessionCommand)
    .command(initCommand)
    .command(scaffoldCommand)
    .command(checkCommand)
    .command(cleanCommand)
    .command(tendCommand)
    .command(acceptCommand)
    .command(skillCommand)
    .command(mcpToolsCommand)
    .command(experimentalCommand)
    .demandCommand(1)
    .strict()
    .help();

  await parser.parseAsync();
  return exitCode;
}
