import { checkCodeInfo, isCheckCode } from "../check/codes.js";
import { formatFinding, type Finding } from "../finding/finding.js";
import type { WritableSink } from "../sink/writable-sink.js";
import { isRunCode, runCodeInfo } from "../finding/run-codes.js";
import { ENVELOPE_SCHEMA_VERSION } from "../record/schema-version.js";
import { readOwnVersion } from "../version.js";
import { isRefusalOnlyCode, refusalCodeInfo, type RefusalCode } from "./refusal-codes.js";

// Responsibility: the one document every command's `--json` prints, and
// the one shape every command uses when it stops without a report (a config
// it cannot load, a target that does not exist, a flag it refuses). A
// refusal is a finding with severity `refused` and a code, so an agent
// reads one grammar and switches on one field whether the command reported
// or refused. Boundary: no command logic; a caller names the code and the
// fields beside `findings`.

export { ENVELOPE_SCHEMA_VERSION };

export type Verdict = "passed" | "failed" | "refused";

/** Exit 2: nothing ran. A script tells "fix the invocation" from exit 1,
 * "it ran and is red", without reading either stream. */
export const REFUSED_EXIT_CODE = 2;
/** Exit 1, for a command that started and then failed while it ran. */
export const FAILED_EXIT_CODE = 1;

/** One verdict for each exit code, so the field and the shell agree. An
 * exit past 2 is a run stopped by a signal, which is red. */
export function verdictOf(exitCode: number): Verdict {
  if (exitCode === 0) return "passed";
  return exitCode === REFUSED_EXIT_CODE ? "refused" : "failed";
}

export interface Envelope {
  readonly schema_version: number;
  readonly nukadoko: string;
  readonly command: string;
  readonly verdict: Verdict;
  readonly findings: readonly Finding[];
}

/** A finding's keys in the order its text line reads: what and where
 * first, then the message, then anything a command adds, then the hints. */
function inReadingOrder(finding: Finding): Finding {
  const { severity, code, file, line, step, message, fix, do: next, ...rest } = finding as Finding & Record<string, unknown>;
  return {
    severity,
    code,
    ...(file !== undefined ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(step !== undefined ? { step } : {}),
    message,
    ...rest,
    ...(fix !== undefined ? { fix } : {}),
    ...(next !== undefined ? { do: next } : {}),
  };
}

/**
 * `finding` with the registry's fix for its code when it names no next step
 * of its own, so every finding a command prints says what gets past it. A
 * raised hint is the more specific one and is kept as it is.
 */
export function withHint(finding: Finding): Finding {
  if (finding.fix !== undefined || finding.do !== undefined) return finding;
  const fix = registryFixOf(finding.code);
  return fix === undefined ? finding : { ...finding, fix };
}

function registryFixOf(code: string): string | undefined {
  if (isRunCode(code)) return runCodeInfo(code).fix;
  if (isRefusalOnlyCode(code)) return refusalCodeInfo(code).fix;
  if (isCheckCode(code)) return checkCodeInfo(code).fix;
  return undefined;
}

/** `fields` sit beside `findings`, after the five fields every envelope
 * has, so a reader that reads the start of the document finds the version
 * and the verdict before the shape. A field a command adds never replaces
 * one of the five: they are written again after `fields`, and a key keeps
 * the position it was first written at. */
export function envelope(
  command: string,
  exitCode: number,
  findings: readonly Finding[],
  fields: Readonly<Record<string, unknown>> = {},
): Envelope & Readonly<Record<string, unknown>> {
  const core: Envelope = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    nukadoko: readOwnVersion(),
    command,
    verdict: verdictOf(exitCode),
    findings: findings.map((finding) => inReadingOrder(withHint(finding))),
  };
  return { ...core, ...fields, ...core };
}

/** The envelope as one pretty-printed document. */
export function formatEnvelope(
  command: string,
  exitCode: number,
  findings: readonly Finding[],
  fields: Readonly<Record<string, unknown>> = {},
): string {
  return `${JSON.stringify(envelope(command, exitCode, findings, fields), null, 2)}\n`;
}

export interface RefusalSinks {
  readonly json: boolean;
  readonly stdout: WritableSink;
  readonly stderr: WritableSink;
  /** The command the envelope names: `check`, `skill path`, or `""` when
   * argv names no command nukadoko has. */
  readonly command: string;
}

export interface Hint {
  readonly fix?: string;
  readonly do?: string;
}

/** An error that knows its code, and the edit or command that gets past it. */
export class RefusalError extends Error {
  readonly code: RefusalCode;
  readonly fix?: string;
  readonly do?: string;

  constructor(code: RefusalCode, message: string, hint: Hint = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "RefusalError";
    this.code = code;
    if (hint.fix !== undefined) this.fix = hint.fix;
    if (hint.do !== undefined) this.do = hint.do;
  }
}

function isKnownCode(code: unknown): code is RefusalCode {
  return typeof code === "string" && (isRefusalOnlyCode(code) || isCheckCode(code));
}

function registryFix(code: RefusalCode): string {
  return isRefusalOnlyCode(code) ? refusalCodeInfo(code).fix : checkCodeInfo(code).fix;
}

function ownString(error: unknown, key: "fix" | "do"): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The refusal finding for `error`. The code is the error's own when it
 * carries a registered one (an error class below the CLI names its code
 * without importing this module), and `code` otherwise. The hint is the
 * error's own `fix` and `do` when it has either, then `hint`, then the
 * code's general fix with the command's help as the `do`: the help is a
 * command that runs as written and lists every flag the command takes.
 * A hint that names only a `do` keeps the code's general fix beside it:
 * the `do` is the next command, and the fix is what the refusal asks to
 * change, so a `do` alone once hid that `since-ref-unknown` wants the
 * ref fetched.
 */
export function refusalOf(error: unknown, code: RefusalCode, command: string, hint?: Hint): Finding {
  const message = error instanceof Error ? error.message : String(error);
  const ownCode = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const resolved = isKnownCode(ownCode) ? ownCode : code;
  const own: Hint = {
    ...(ownString(error, "fix") !== undefined ? { fix: ownString(error, "fix") } : {}),
    ...(ownString(error, "do") !== undefined ? { do: ownString(error, "do") } : {}),
  };
  const chosen: Hint =
    own.fix !== undefined || own.do !== undefined
      ? own
      : hint !== undefined && (hint.fix !== undefined || hint.do !== undefined)
        ? hint
        : { fix: registryFix(resolved), do: helpFor(command) };
  const fix = chosen.fix ?? registryFix(resolved);
  return {
    severity: "refused",
    code: resolved,
    message,
    fix,
    ...(chosen.do !== undefined ? { do: chosen.do } : {}),
  };
}

/** `error` with `message` in place of its own, keeping its code and its
 * hint: a command that words the failure for its own reader still refuses
 * with the cause's code. */
export function restated(error: unknown, message: string, code: RefusalCode, command: string): RefusalError {
  const finding = refusalOf(error, code, command);
  const ownHint = ownString(error, "fix") !== undefined || ownString(error, "do") !== undefined;
  return new RefusalError(finding.code as RefusalCode, message, ownHint ? finding : {});
}

/** Writes the findings as the command's whole output and returns
 * `exitCode`: under `--json` one envelope on stdout and nothing on stderr,
 * otherwise each finding's lines on stderr. */
export function writeStopped(sinks: RefusalSinks, findings: readonly Finding[], exitCode: number): number {
  if (sinks.json) {
    sinks.stdout.write(formatEnvelope(sinks.command, exitCode, findings));
  } else {
    for (const finding of findings) sinks.stderr.write(formatFinding(withHint(finding)));
  }
  return exitCode;
}

/** Writes the refusal and returns exit 2. `before` are findings the
 * refusal stands on (the check errors `nuka run` stops over), printed
 * ahead of it in the same grammar. */
export function refuse(
  sinks: RefusalSinks,
  error: unknown,
  code: RefusalCode,
  hint?: Hint,
  before: readonly Finding[] = [],
): number {
  return writeStopped(sinks, [...before, refusalOf(error, code, sinks.command, hint)], REFUSED_EXIT_CODE);
}

/** The same shape as `refuse`, for a command that had started: a handler
 * that threw is not the invocation's fault, so it exits 1 and its severity
 * is `error`. */
export function failInShape(sinks: RefusalSinks, error: unknown, code: RefusalCode, hint?: Hint): number {
  return writeStopped(sinks, [{ ...refusalOf(error, code, sinks.command, hint), severity: "error" }], FAILED_EXIT_CODE);
}

/**
 * The command an argv names, as far as `commands` (top-level name to its
 * subcommand names) knows it: `["skill", "path", "x"]` is `"skill
 * path"`, an unknown or missing first word is `""`. A yargs failure has no
 * parsed command to ask, so this reads argv the way a person typed it.
 */
export function commandPathOf(argv: readonly string[], commands: ReadonlyMap<string, readonly string[]>): string {
  const words = argv.filter((word) => !word.startsWith("-"));
  const top = words[0];
  if (top === undefined || !commands.has(top)) return "";
  const sub = words[1];
  return sub !== undefined && commands.get(top)!.includes(sub) ? `${top} ${sub}` : top;
}

/** The line a command that reads the config writes when the directory has
 * none, as a warning finding. */
export function configMissingFinding(line: string): Finding {
  return withHint({ severity: "warning", code: "config-missing", message: line });
}

/** The fallback `do` for a command: its own help. */
export function helpFor(command: string): string {
  return command === "" ? "nuka --help" : `nuka ${command} --help`;
}
