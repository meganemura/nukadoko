import yargs from "yargs";
// TODO(types): @types/yargs is pinned to the 17.x line (no 18.x types on
// DefinitelyTyped yet per the task's constraints); CommandModule/Argv here
// are the 17.x shapes. yargs 18's runtime behavior used below (command
// builders, .fail(), parseAsync()) is unchanged from 17, so this is a type
// approximation, not a behavior mismatch.
import type { Arguments, Argv, CommandModule } from "yargs";
import { loadVocabulary, describeContract, formatVocabularyError, summarize } from "./vocabulary.js";

// Responsibility: wires the two commands this slice ships (`steps`,
// `describe`) to yargs and turns any failure — yargs' own (bad flags, no
// command) or ours (config/discovery errors, unknown step name) — into
// stderr output plus a non-zero exit code, without ever calling
// `process.exit` itself. That is `cli.ts`'s job, so this function stays
// callable directly from tests.

// Narrower than NodeJS.WritableStream on purpose: it's the entire surface
// this module needs, and it's trivial to fake in a test without matching
// the real stream interface's many unrelated members.
export interface WritableSink {
  write(chunk: string): unknown;
}

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

  const parser = yargs(argv)
    .scriptName("nuka")
    .exitProcess(false)
    .fail((msg: string | null, err: Error | undefined) => {
      exitCode = 1;
      stderr.write(`${err instanceof Error ? err.message : (msg ?? "unknown error")}\n`);
    })
    .command(stepsCommand)
    .command(describeCommand)
    .demandCommand(1)
    .strict()
    .help();

  await parser.parseAsync();
  return exitCode;
}
