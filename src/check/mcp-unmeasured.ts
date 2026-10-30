import type { Vocabulary } from "../discover/discover-steps.js";
import type { NukadokoConfig } from "../config/schema.js";
import { fixtureSourceOf } from "../step/define-step.js";
import { fixtureFnOf } from "../step/fixture-types.js";
import type { CheckIssue } from "./types.js";
import { codeOnly } from "./unseeded-random.js";

// Responsibility: the `mcp-transport-unmeasured` note, an MCP client
// connected to a transport built inside the `connect` call itself, as in
// `client.connect(new StdioClientTransport(...))`. Such a transport never
// passes through `measureMcp` (src/context/measure-mcp.ts), so no call the
// client sends reaches a step record or carries the step's trace context.
// It reads the source text of each config fixture and each typed step's
// function only; it never calls one.
//
// Only that one shape is named, since only it can end one way: the object
// exists nowhere but in the argument, so nothing can wrap it later. A
// transport built first and passed by name may be wrapped on another line
// or in another file, and is not reported. A class whose name ends in
// `ClientTransport` is an MCP client transport in the SDKs MCP publishes;
// a `connect` given one is an MCP client's.

const UNWRAPPED = /\.\s*connect\s*\(\s*new\s+([A-Za-z_$][\w$]*ClientTransport)\s*\(/g;

/** The transport classes `source` builds inside a `connect` call, in the
 * order written. */
export function transportsBuiltInConnect(source: string): string[] {
  return [...codeOnly(source).matchAll(UNWRAPPED)].map((match) => match[1]!);
}

function sourceText(fn: unknown): string {
  try {
    return typeof fn === "function" ? Function.prototype.toString.call(fn) : "";
  } catch {
    return "";
  }
}

function message(subject: string, classes: readonly string[]): string {
  const named = [...new Set(classes)].join(", ");
  return `${subject} connects an MCP client to a new ${named} inside the connect call, so nothing wraps it in measureMcp: its calls reach no step record and carry no trace context.`;
}

export function findUnmeasuredMcpTransports(vocabulary: Vocabulary, config: Pick<NukadokoConfig, "fixtures">): CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const [name, definition] of Object.entries(config.fixtures)) {
    const classes = transportsBuiltInConnect(sourceText(fixtureFnOf(definition)));
    if (classes.length > 0) issues.push({ code: "mcp-transport-unmeasured", fixture: name, message: message(`Fixture "${name}"`, classes) });
  }
  for (const entry of vocabulary.values()) {
    if (entry.kind !== "typed") continue;
    const classes = transportsBuiltInConnect(sourceText(fixtureSourceOf(entry.step)));
    if (classes.length > 0) issues.push({ code: "mcp-transport-unmeasured", step: entry.name, message: message(`Step "${entry.name}"`, classes) });
  }
  return issues;
}
