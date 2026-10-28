// Responsibility: every code a refusal can carry that is not already a
// `nuka check` finding code, each with the description `nuka check --codes`
// prints and the edit that gets past it. Boundary: data only. A refusal
// that has the same cause as a check finding (a feature file that does not
// parse, a step file that does not import) carries the check code, so an
// agent switches on one code for one cause whichever command found it.

import type { CheckCode } from "../check/codes.js";

export interface RefusalCodeInfo {
  /** Set only on a code the CLI raises as a warning before a command
   * runs; every other code here is a refusal. */
  readonly severity?: "warning";
  readonly description: string;
  readonly fix: string;
}

const REFUSAL_CODES = {
  "base-features-at-root": {
    description: "nuka run --base needs the scenarios and their steps in a directory of their own, and featuresDir is the project root, where the program's code is too.",
    fix: "Move the feature files and the step files into a directory of their own, such as features/, and set featuresDir to it.",
  },
  "base-git-failed": {
    description: "nuka run --base could not ask git what it needs, or could not check the base out into the run's directory: git is missing, or a git command failed.",
    fix: "Run the git command the message names to see its error, or install git.",
  },
  "base-outside-git": {
    description: "nuka run --base compares with a git commit, and the project is not inside a git repository.",
    fix: "Run nuka run --base inside the git repository that holds the project, or run without --base.",
  },
  "base-ref-unknown": {
    description: "nuka run --base names a ref that is no commit in the project's repository.",
    fix: "Name a branch, tag, or commit the repository holds, such as the pull request's base.",
  },
  "base-shallow": {
    description: "nuka run --base names a ref that this shallow clone does not hold, because it holds only part of the history.",
    fix: "Fetch the base first with the command the refusal names, or fetch-depth: 0 on actions/checkout.",
  },
  "check-errors": {
    description: "nuka run did not start, because nuka check reports errors for the selected scenarios.",
    fix: "Correct each error the findings name, or pass --no-check to run anyway.",
  },
  "compat-step-not-runnable": {
    description: "nuka do names a compat step, which has no typed contract to run alone.",
    fix: "Promote the step to defineStep to run it with nuka do.",
  },
  "config-exists": {
    description: "nuka init found a config file, and writes nothing over it.",
    fix: "Edit the config file that exists, or delete it to start again.",
  },
  "config-in-parent": {
    description: "There is no config file here, and one exists in a parent directory, so a file written here is not one that config reads.",
    fix: "Run the command from the directory that holds the config file.",
  },
  "config-missing": {
    severity: "warning",
    description: "There is no config file in the directory nuka runs in, so the defaults apply.",
    fix: "Run nuka from the directory that holds the config file, or run nuka init to write one.",
  },
  "config-key-removed": {
    description: "The config file sets a key that an earlier release removed.",
    fix: "Remove the key from the config file, and do what the message names in its place.",
  },
  "config-invalid": {
    description: "The config file did not load: it does not import, it has no default export, or a field is wrong.",
    fix: "Correct the config file as the message says.",
  },
  "duplicate-step": {
    description: "Two step files register the same typed step name, or two registrations have the same compat pattern.",
    fix: "Rename or remove one of the two definitions the message names.",
  },
  "duplicate-world": {
    description: "defineWorld is called more than once in the step files.",
    fix: "Keep one defineWorld call, and remove the others.",
  },
  "env-file-unreadable": {
    description: "A configured envFiles path is on disk and could not be read: a directory, or a file without read permission. The run stops before any step runs.",
    fix: "Make the file readable, replace the directory with a file, or remove the path from envFiles.",
  },
  "fail-on-unknown-code": {
    description: "--fail-on names a code that a nuka check report never contains.",
    fix: "Name an error, warning, or note code that nuka check --codes lists.",
  },
  "fail-on-note-with-targets": {
    description: "nuka check with targets was given a --fail-on note code, and a check with targets computes no notes, so the gate could never fire.",
    fix: "Run nuka check without targets to gate on a note, or leave the note out of --fail-on.",
  },
  "file-edited": {
    description: "The file nuka scaffold would replace is not what scaffold wrote, so --replace leaves it.",
    fix: "Edit the file by hand, or delete it and run nuka scaffold again.",
  },
  "file-exists": {
    description: "The file nuka scaffold would write exists.",
    fix: "Pass --replace if scaffold wrote the file and nobody edited it, or delete the file.",
  },
  "invalid-arguments": {
    description: "The command line names an unknown command or flag, or leaves out a required one.",
    fix: "Correct the command line; the command's --help lists its flags.",
  },
  "invalid-step-definition": {
    description: "A step file calls defineStep with a definition nukadoko cannot register.",
    fix: "Correct the defineStep call the message names.",
  },
  "invalid-value": {
    description: "A flag has a value the command cannot use.",
    fix: "Correct the flag's value as the message says.",
  },
  "line-on-directory": {
    description: "A target names a directory with a :line suffix, and a line selects a scenario in one file only.",
    fix: "Remove the :line suffix from the directory, or name a feature file.",
  },
  "line-not-supported": {
    description: "A target has a :line suffix, and the command reads whole files: nuka check analyzes every scenario in a file.",
    fix: "Remove the :line suffix from the target.",
  },
  "markdown-target": {
    description: "A target names a Markdown file: Markdown oaths were removed, and scenarios live in .feature files only.",
    fix: "Write the scenarios of the file as Gherkin in a .feature file, and name that file.",
  },
  "no-feature-files": {
    description: "A target directory holds no feature file, so nothing can run.",
    fix: "Add a feature file under the directory, or name another target.",
  },
  "no-scenario-at-line": {
    description: "A target's :line is not the line a scenario or an Examples row starts on.",
    fix: "Name the line that a scenario or an Examples row starts on.",
  },
  "parameter-type-collision": {
    description: "A parameter type has the name of a built-in type or of another registered type.",
    fix: "Rename the parameter type, or remove one of the two registrations.",
  },
  "read-only-environment": {
    description: "A step that declares mutates: true targets an environment whose policy is read-only.",
    fix: "Run the step against an environment that allows writes, or declare mutates: false if it only reads.",
  },
  "removed-command": {
    description: "The command line names a command that an earlier release removed.",
    fix: "Use what the message names in its place.",
  },
  "removed-flag": {
    description: "The command line names a flag that an earlier release removed.",
    fix: "Use what the message names in its place.",
  },
  "report-out-invalid": {
    description: "nuka report --out names a place the render cannot write: a directory where a file goes, a file where a directory goes, a FIFO or another special file, a dangling symbolic link, a path under a regular file, the Allure history file, or a markdown or messages file the file system refuses to write.",
    fix: "Name a regular file for markdown and messages, or a directory for allure, under a directory that exists or can be created.",
  },
  "run-not-found": {
    description: "nuka report found no run to render: the directory it names holds no run.json, or the state directory holds no run that ended.",
    fix: "Name a run directory that holds a run.json, or run nuka run first.",
  },
  "run-invalid": {
    description: "The run directory's run.json does not parse, has another schema version, or lacks a field nuka report reads.",
    fix: "Render a run directory that nuka run of this release wrote, unedited; the message names what is wrong.",
  },
  "run-sources-invalid": {
    description: "The run directory's sources.json does not parse, lacks a field, or has another schema version.",
    fix: "Render a run directory that nuka run of this release wrote, unedited; the message names what is wrong.",
  },
  "run-sources-missing": {
    description: "The run directory holds no sources.json, the feature text nuka report --format allure and messages parse the run's scenarios from. A run an earlier release wrote has none.",
    fix: "Run the scenarios again with this release, and render that run.",
  },
  "step-args-invalid": {
    description: "nuka do has no --args, or --args is not valid JSON.",
    fix: "Pass --args as a JSON object with the keys that nuka describe <step> lists.",
  },
  "step-inputs-invalid": {
    description: "nuka do cannot run the step as given: a from key, a fixture, or a --use record does not fit.",
    fix: "Correct the step or the flags as the message says.",
  },
  "target-not-found": {
    description: "A target names a file or a directory that does not exist.",
    fix: "Name a file or a directory that exists.",
  },
  "target-unreadable": {
    description: "A target exists, and nukadoko could not read it.",
    fix: "Make the file readable, or name another target.",
  },
  "unexpected-error": {
    description: "The command stopped on an error that has no code of its own.",
    fix: "Read the message; it is the error the command stopped on.",
  },
  "unknown-environment": {
    description: "--env names an environment that nukadoko.program.ts does not define.",
    fix: "Pass default or an environment nukadoko.program.ts defines, or add it to environments there.",
  },
  "unknown-step": {
    description: "The command names a step that is not in the vocabulary.",
    fix: "Name a step that nuka steps lists.",
  },
} as const satisfies Record<string, RefusalCodeInfo>;

export type RefusalOnlyCode = keyof typeof REFUSAL_CODES;
export type RefusalCode = RefusalOnlyCode | CheckCode;

export function isRefusalOnlyCode(code: string): code is RefusalOnlyCode {
  return Object.hasOwn(REFUSAL_CODES, code);
}

export function refusalCodeInfo(code: RefusalOnlyCode): RefusalCodeInfo {
  return REFUSAL_CODES[code];
}

/** Every refusal-only code, in code-ascending order. */
export function listRefusalCodes(): ReadonlyArray<{ code: RefusalOnlyCode } & RefusalCodeInfo> {
  return (Object.keys(REFUSAL_CODES) as RefusalOnlyCode[])
    .sort((a, b) => a.localeCompare(b))
    .map((code) => ({ code, ...REFUSAL_CODES[code] }));
}
