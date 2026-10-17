import { existsSync } from "node:fs";
import path from "node:path";

// Responsibility: the stderr line `nuka check` writes when a target does
// not resolve to a file or a directory. A missing path, a `:line` suffix,
// and any other error (a file used as a directory) all fail the same
// `statSync`. Reporting every one of them as "feature file not found"
// sends the reader looking for a file that is right there. Only ENOENT is
// a missing path. A `:line` suffix is ENOENT on the suffixed path, so it
// is told apart by whether the path with `:<digits>` removed exists, and
// refused: check analyzes whole files. Every other code keeps the error's
// own text.
//
// The suffix pattern matches `nuka run`'s own trailing `:<digits>` and
// nothing else. It lives here, not in the runner: check sits below the
// runner and must not import it, and no legitimate feature path ends in
// `:<digits>` on its own.

const LINE_SUFFIX_PATTERN = /^(.+):(\d+)$/;

export type FeatureArgCommand = "nuka check" | "nuka scaffold --feature";

export type FeatureArgReadKind = "not-found" | "line" | "other";

export interface FeatureArgReadInput {
  readonly command: FeatureArgCommand;
  /** Root-relative path, including a `:line` suffix when one was given. */
  readonly relativePath: string;
  /** `code` from a Node system error, when the failure has one. */
  readonly code: string | undefined;
  /** The thrown error's own message. Used for every code other than ENOENT. */
  readonly errorMessage: string;
  /**
   * Whether the path with a trailing `:<digits>` removed exists.
   * Ignored unless `code` is ENOENT and `relativePath` carries that suffix.
   */
  readonly lineBaseExists: boolean;
}

export interface FeatureArgReadDescription {
  readonly kind: FeatureArgReadKind;
  readonly message: string;
  readonly basePath?: string;
  readonly line?: string;
}

export function describeFeatureArgRead(input: FeatureArgReadInput): FeatureArgReadDescription {
  if (input.code !== "ENOENT") {
    return {
      kind: "other",
      message: `${input.command}: ${input.errorMessage}`,
    };
  }
  const lineMatch = LINE_SUFFIX_PATTERN.exec(input.relativePath);
  if (lineMatch && input.lineBaseExists) {
    const basePath = lineMatch[1]!;
    const line = lineMatch[2]!;
    return {
      kind: "line",
      basePath,
      line,
      message: lineNotSupportedMessage(input.command, basePath, line),
    };
  }
  return {
    kind: "not-found",
    message: `${input.command}: feature file not found: ${input.relativePath}`,
  };
}

function lineNotSupportedMessage(command: FeatureArgCommand, basePath: string, line: string): string {
  return (
    `${command}: ${basePath}:${line}: :line is not supported; check analyzes the whole file, not one scenario. ` +
    `Run: ${command} ${basePath}`
  );
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Asks the filesystem the one extra question `:line` needs (does the path
 * with `:<digits>` removed exist?) and returns the stderr line. */
export function describeFailedFeatureRead(
  command: FeatureArgCommand,
  rootDir: string,
  relativePath: string,
  error: unknown,
): FeatureArgReadDescription {
  const code = readErrorCode(error);
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lineMatch = code === "ENOENT" ? LINE_SUFFIX_PATTERN.exec(relativePath) : null;
  const lineBaseExists = lineMatch !== null && existsSync(path.join(rootDir, lineMatch[1]!));
  return describeFeatureArgRead({ command, relativePath, code, errorMessage, lineBaseExists });
}
