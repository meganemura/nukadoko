// Responsibility: the grouped command list `nuka --help` prints, and the
// wrapper that keeps each grouped command's own `nuka <command> --help`
// unchanged. Boundary: it renders text and adapts a yargs CommandModule; it
// never parses argv or runs a command (run-cli.ts registers and runs them).
//
// yargs lists commands under one flat "Commands:" heading in registration
// order and has no grouping for commands (its `group()` is for options).
// A newcomer reading that list could not tell which four commands are the
// whole everyday loop, so the top-level list is rendered here from a table
// instead. Each grouped command is registered with `describe: false`, which
// keeps yargs from printing its own flat copy; yargs would then also drop
// the description from that command's own help screen, so the wrapper puts
// it back as that screen's usage text.

import type { Argv, CommandModule } from "yargs";

/** The last lines of `nuka --help`: an agent that only ran `--help` learns
 * where the file written for it is. */
export const AGENT_ENTRY_POINT =
  "An agent starts at node_modules/nukadoko/llms.txt: the loop, every command,\nand every finding code. nuka skill path prints the skills beside it.";

/** yargs wraps its own help at 80 columns on a wide terminal; the grouped list matches it. */
export const HELP_WIDTH = 80;

export interface HelpGroup {
  readonly heading: string;
  readonly commands: readonly CommandModule<any, any>[];
}

export interface HelpLine {
  /** The command as typed, e.g. `run <feature..>`, without the script name. */
  readonly usage: string;
  readonly describe: string;
}

function commandString(command: CommandModule<any, any>): string {
  const value = command.command;
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function describeOf(command: CommandModule<any, any>): string {
  return typeof command.describe === "string" ? command.describe : "";
}

export function helpLines(group: HelpGroup): HelpLine[] {
  return group.commands.map((command) => ({ usage: commandString(command), describe: describeOf(command) }));
}

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * The top-level help body: one heading per group, then each command and its
 * description, the description wrapped under its own column. A word longer
 * than the column stays whole on its own line rather than being split.
 */
export function renderCommandGroups(
  scriptName: string,
  groups: readonly { readonly heading: string; readonly lines: readonly HelpLine[] }[],
  width: number,
): string {
  const indent = "  ";
  const commandWidth = Math.max(
    0,
    ...groups.flatMap((group) => group.lines.map((line) => `${scriptName} ${line.usage}`.length)),
  );
  const column = indent.length + commandWidth + indent.length;
  const describeWidth = Math.max(20, width - column);
  const out: string[] = [];
  for (const group of groups) {
    if (out.length > 0) out.push("");
    out.push(`${group.heading}:`);
    for (const line of group.lines) {
      const head = `${indent}${scriptName} ${line.usage}`.padEnd(column);
      const wrapped = wrapWords(line.describe, describeWidth);
      out.push(`${head}${wrapped[0] ?? ""}`.trimEnd());
      for (const rest of wrapped.slice(1)) out.push(`${" ".repeat(column)}${rest}`);
    }
  }
  return out.join("\n");
}

/**
 * Registers `command` without yargs' own entry in the flat list, and gives
 * its own help screen the usage line and description yargs would have
 * printed there.
 */
export function withoutFlatListing<T, U>(command: CommandModule<T, U>): CommandModule<T, U> {
  const { builder } = command;
  const usage = `$0 ${commandString(command)}\n\n${describeOf(command)}`;
  return {
    ...command,
    describe: false,
    builder: (y: Argv<T>) => {
      const built =
        typeof builder === "function"
          ? (builder(y) as Argv<U>)
          : builder !== undefined
            ? (y.options(builder) as unknown as Argv<U>)
            : (y as unknown as Argv<U>);
      // The top level turns yargs' wrapping off so the grouped list keeps
      // its own indentation; a command's own screen turns it back on, at
      // the width yargs picks by default (the terminal's, at most 80).
      const columns = y.terminalWidth();
      return built.usage(usage).wrap(columns ? Math.min(HELP_WIDTH, columns) : HELP_WIDTH);
    },
  };
}
