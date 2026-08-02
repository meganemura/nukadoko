import yargs from "yargs";
// TODO(types): @types/yargs is pinned to the 17.x line (no 18.x types on
// DefinitelyTyped yet per the task's constraints); CommandModule/Argv here
// are the 17.x shapes. yargs 18's runtime behavior used below (command
// builders, .fail(), parseAsync()) is unchanged from 17, so this is a type
// approximation, not a behavior mismatch.
import type { Arguments, Argv, CommandModule } from "yargs";
import { runCheck } from "./check.js";
import { runDo } from "./do.js";
import { runInit } from "./init.js";
import { runRun } from "./run.js";
import { runScaffold } from "./scaffold.js";
import { runSessionClear, runSessionList } from "./session.js";
import { loadVocabulary, describeContract, formatVocabularyError, summarize } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: wires the commands this slice ships (`steps`, `describe`,
// `do`, `session list`/`clear`, `init`, `scaffold`, `check`) to yargs and turns any
// failure — yargs' own (bad flags, no command) or ours (config/discovery
// errors, unknown step name) — into stderr output plus a non-zero exit
// code, without ever calling `process.exit` itself. That is `cli.ts`'s job,
// so this function stays callable directly from tests. `do`'s own setup/
// execution split and receipt writing lives in cli/do.ts; `session`'s own
// list/clear logic lives in cli/session.ts; `init`/`scaffold`'s own
// generation logic lives in cli/init.ts and cli/scaffold.ts; `check`'s own
// analysis lives in cli/check.ts (thin wiring) and src/check/* (the actual
// checks); this module only wires their argv shapes and reports their exit
// codes.

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
  args: string;
  session?: string;
  env?: string;
}

interface RunArgs {
  feature: string;
  session?: string;
  env?: string;
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
}

interface ScaffoldArgs {
  name: string;
}

interface CheckArgs {
  json?: boolean;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const rootDir = options.rootDir ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  let exitCode = 0;

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
      try {
        const vocabulary = await loadVocabulary(rootDir);
        const summaries = [...vocabulary.values()].map(summarize);
        if (args.json) {
          stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
        } else {
          for (const s of summaries) {
            const patterns = s.patterns.length > 0 ? s.patterns.join(" | ") : "(no pattern)";
            stdout.write(
              `${s.name}\t${patterns}\t${s.mutates ? "mutates" : "read-only"}\t${s.description}\n`,
            );
          }
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
      try {
        const vocabulary = await loadVocabulary(rootDir);
        const entry = vocabulary.get(args.name);
        if (!entry) {
          exitCode = 1;
          stderr.write(`Unknown step: ${args.name}\n`);
          return;
        }
        stdout.write(`${JSON.stringify(describeContract(entry), null, 2)}\n`);
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
          demandOption: true,
          describe: "step arguments as a JSON object",
        })
        .option("session", {
          type: "string",
          describe: "carry login state across calls via a named session",
        })
        .option("env", {
          type: "string",
          describe: 'target a named environment (omit for the "default" environment)',
        }) as Argv<DoArgs>,
    handler: async (args: Arguments<DoArgs>) => {
      exitCode = await runDo({
        rootDir,
        name: args.name,
        argsJson: args.args,
        session: args.session ?? null,
        env: args.env ?? null,
        stdout,
        stderr,
      });
    },
  };

  const runCommand: CommandModule<Record<string, never>, RunArgs> = {
    command: "run <feature>",
    describe: "execute scenarios from a feature file; receipts + scenario records",
    builder: (y: Argv) =>
      y
        .positional("feature", {
          type: "string",
          demandOption: true,
          describe: "feature file path, optionally with :line (e.g. features/checkout.feature:12)",
        })
        .option("session", {
          type: "string",
          describe: "carry login state across calls via a named session",
        })
        .option("env", {
          type: "string",
          describe: 'target a named environment (omit for the "default" environment)',
        }) as Argv<RunArgs>,
    handler: async (args: Arguments<RunArgs>) => {
      exitCode = await runRun({
        rootDir,
        featureArg: args.feature,
        session: args.session ?? null,
        env: args.env ?? null,
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
      y.option("base-url", {
        type: "string",
        describe: "baseURL to record in the generated config",
      }) as Argv<InitArgs>,
    handler: async (args: Arguments<InitArgs>) => {
      exitCode = await runInit({
        rootDir,
        baseUrl: args.baseUrl ?? null,
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
      exitCode = await runScaffold({
        rootDir,
        name: args.name,
        stdout,
        stderr,
      });
    },
  };

  const checkCommand: CommandModule<Record<string, never>, CheckArgs> = {
    command: "check",
    describe:
      "static checks: pattern/schema mismatches, Then binding to mutating steps, undefined steps per feature, duplicate patterns, config coherence",
    builder: (y: Argv) =>
      y.option("json", {
        type: "boolean",
        default: false,
        describe: "machine-readable output",
      }) as Argv<CheckArgs>,
    handler: async (args: Arguments<CheckArgs>) => {
      exitCode = await runCheck({
        rootDir,
        json: args.json ?? false,
        stdout,
        stderr,
      });
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
    .exitProcess(false)
    .fail((msg: string | null, err: Error | undefined) => {
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
    .demandCommand(1)
    .strict()
    .help();

  await parser.parseAsync();
  return exitCode;
}
