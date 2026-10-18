// Responsibility: the one shape a finding, a refusal, and a failed scenario
// take, and the one text grammar every command prints them in. Boundary:
// pure. No registry, no I/O: a caller fills the code's text and writes the
// lines.
//
// A finding names its next step in at most two ways. `do` is a command a
// shell runs as written. `fix` is an edit, in words, naming the file and
// what to write. A next step that is a choice between edits, or a command
// with a value nukadoko cannot fill, is a `fix`: a `do` that guesses sends
// an agent to run the wrong thing with confidence. When both are present the
// edit comes first, so `fix:` prints before `do:`.

export const SEVERITIES = ["error", "warning", "note", "refused", "failed"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
  readonly fix?: string;
  readonly do?: string;
}

/** A finding as its text lines carry it: the location folded into one
 * column, and `paths` for the continuation lines a grouped finding lists. */
export interface FindingText {
  readonly severity: Severity;
  readonly code: string;
  readonly where: string;
  readonly message: string;
  readonly paths?: readonly string[];
  readonly fix?: string;
  readonly do?: string;
}

/** The third column: `file:line`, `file`, the step name, or `-`. */
export function whereOf(finding: Pick<Finding, "file" | "line" | "step">): string {
  if (finding.file !== undefined) return finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
  return finding.step ?? "-";
}

/** One line of text: a message may hold a multi-line pointer or a pasted
 * stack, and the grammar is one line per finding. A tab would split it into
 * a fifth column. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]\s*/g, " ").replace(/\t/g, " ");
}

export function toText(finding: Finding): FindingText {
  return {
    severity: finding.severity,
    code: finding.code,
    where: whereOf(finding),
    message: finding.message,
    ...(finding.fix !== undefined ? { fix: finding.fix } : {}),
    ...(finding.do !== undefined ? { do: finding.do } : {}),
  };
}

/** The finding's lines, each ended with a newline. */
export function formatFindingText(finding: FindingText): string {
  const lines = [
    `${finding.severity}\t${finding.code}\t${oneLine(finding.where)}\t${oneLine(finding.message)}`,
    ...(finding.paths ?? []).map((entry) => `  ${oneLine(entry)}`),
    ...(finding.fix !== undefined ? [`  fix: ${oneLine(finding.fix)}`] : []),
    ...(finding.do !== undefined ? [`  do: ${oneLine(finding.do)}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

export function formatFinding(finding: Finding): string {
  return formatFindingText(toText(finding));
}

const HEAD = new RegExp(`^(${SEVERITIES.join("|")})\\t([^\\t]+)\\t([^\\t]*)\\t(.*)$`);

/**
 * Every finding in `text`, in order. A line that is neither a finding's
 * first line nor indented under one (a summary line, a path) is skipped,
 * so the parser reads a command's whole output and keeps only the
 * findings.
 */
export function parseFindings(text: string): FindingText[] {
  const found: { -readonly [K in keyof FindingText]: FindingText[K] }[] = [];
  let current: (typeof found)[number] | undefined;
  for (const line of text.split("\n")) {
    const head = HEAD.exec(line);
    if (head !== null) {
      current = { severity: head[1] as Severity, code: head[2]!, where: head[3]!, message: head[4]! };
      found.push(current);
      continue;
    }
    if (current === undefined || !line.startsWith("  ")) {
      current = undefined;
      continue;
    }
    const body = line.slice(2);
    if (body.startsWith("fix: ")) current.fix = body.slice(5);
    else if (body.startsWith("do: ")) current.do = body.slice(4);
    else current.paths = [...(current.paths ?? []), body];
  }
  return found;
}

/** A warning's text without the `Warning:` a lower module's own line starts
 * with, since the severity column already says it. */
export function withoutWarningPrefix(line: string): string {
  return line.replace(/^warning:\s*/i, "");
}

/**
 * A sink for a module that writes its warnings as text lines: each line
 * becomes one `warning` finding with `code`, handed to `emit`. A chunk
 * that does not end in a newline is held until one arrives, so a line
 * split across writes is still one finding.
 */
export function warningSink(code: string, emit: (finding: Finding) => void): { write(chunk: string): boolean } {
  let pending = "";
  return {
    write(chunk: string): boolean {
      const parts = (pending + chunk).split("\n");
      pending = parts.pop()!;
      for (const line of parts) {
        if (line.trim() !== "") emit({ severity: "warning", code, message: withoutWarningPrefix(line) });
      }
      return true;
    },
  };
}
