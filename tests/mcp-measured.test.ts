import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import type { McpCallLine } from "../src/record/types.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunDir, latestRunJson, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: MCP calls measured end to end against
// tests/fixtures/mcp-project. Its clients are connected in scenario
// fixtures, outside every step, through measureMcp, and called from steps:
// one to the world's MCP server over HTTP, one to a stdio server that
// posts to the world. Each call is a line of the calling step's mcp.jsonl,
// carries the step's trace context in `params._meta`, and, over HTTP, the
// same value in its header, so the world's request line closes the call
// and a count of its writes is exact. A stdio call has no such line, so
// only a lower bound holds, and an exact count is unjudged.

async function cli(rootDir: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = createCaptureSink();
  const stderr = createCaptureSink();
  const exitCode = await runCli(args, { rootDir, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

interface StepFacts {
  readonly text: string;
  readonly status: string;
  readonly record: string;
  readonly observed: {
    readonly mcp?: number;
    readonly http: number | null;
    readonly events?: {
      readonly trace_id: string;
      readonly kinds: Record<string, number>;
      readonly stamped_spans: readonly string[];
      readonly mcp_spans?: readonly string[];
      readonly whole: boolean;
      readonly open: readonly { readonly gap: string; readonly [key: string]: unknown }[];
    } | null;
  };
}

function stepsOf(rootDir: string): Map<string, StepFacts> {
  const run = latestRunJson(rootDir);
  return new Map((run.scenarios as { steps: StepFacts[] }[]).flatMap((scenario) => scenario.steps.map((step) => [step.text, step] as const)));
}

function jsonLines<T>(rootDir: string, step: StepFacts, file: string): T[] {
  return readFileSync(path.join(latestRunDir(rootDir), step.record, file), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as T);
}

function recordOf(rootDir: string, step: StepFacts): { evidence: { mcp?: string } } {
  return JSON.parse(readFileSync(path.join(latestRunDir(rootDir), step.record, "record.json"), "utf8")) as { evidence: { mcp?: string } };
}

function spanOf(traceparent: string | undefined, traceId: string): string | undefined {
  return new RegExp(`^00-${traceId}-([0-9a-f]{16})-01$`).exec(traceparent ?? "")?.[1];
}

describe("MCP calls through measureMcp", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("mcp-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("records each call in the step that sent it and counts what the world wrote for it", async () => {
    const result = await cli(rootDir, ["run", "features/mcp.feature"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const steps = stepsOf(rootDir);
    const step = (text: string): StepFacts => {
      const found = steps.get(text);
      expect(found, text).toBeDefined();
      return found!;
    };

    // Over HTTP: the connect in the fixture is no step's, so the step has
    // its one call; the header and `_meta` carry one value, and the
    // world's request line for it closes the call.
    const milk = step('the agent adds the note "milk" over HTTP');
    expect(milk.observed.mcp).toBe(1);
    expect(recordOf(rootDir, milk).evidence.mcp).toBe("mcp.jsonl");
    const [call, ...more] = jsonLines<McpCallLine>(rootDir, milk, "mcp.jsonl");
    expect(more).toEqual([]);
    const traceId = milk.observed.events!.trace_id;
    const span = spanOf(call!.traceparent, traceId);
    expect(span).toBeDefined();
    const [sent, ...moreSent] = jsonLines<{ url: string; traceparent?: string }>(rootDir, milk, "http.jsonl");
    expect(moreSent).toEqual([]);
    expect(sent!.traceparent).toBe(call!.traceparent);
    expect(call).toMatchObject({ method: "tools/call", id: 2, tool: "add_note", header_sent_to: [new URL(sent!.url).origin] });
    expect(JSON.parse(call!.params!.text!)).toEqual({ name: "add_note", arguments: { text: "milk" }, _meta: { traceparent: call!.traceparent } });
    expect(JSON.parse(call!.result!.text!)).toEqual({ content: [{ type: "text", text: "note 1" }], structuredContent: { id: 1 } });
    expect(call!.is_error).toBeUndefined();
    expect(milk.observed.events).toMatchObject({ kinds: { db: 1, request: 1 }, stamped_spans: [span], mcp_spans: [span], whole: true, open: [] });
    expect(step("the HTTP call inserted 1 note").status).toBe("passed");

    // A tool that reports an error is an answer: the line says so, the
    // world wrote nothing, and its request line makes that an absence.
    const empty = step('the agent adds the note "" over HTTP');
    expect(jsonLines<McpCallLine>(rootDir, empty, "mcp.jsonl")).toEqual([expect.objectContaining({ tool: "add_note", is_error: true })]);
    expect(empty.observed.events).toMatchObject({ kinds: { request: 1 }, whole: true });
    expect(step("the HTTP call inserted 0 notes").status).toBe("passed");

    // A JSON-RPC error keeps its code and message, and no result.
    const unknown = step("the agent calls a tool the server does not have");
    const [refused] = jsonLines<McpCallLine>(rootDir, unknown, "mcp.jsonl");
    expect(refused).toMatchObject({ tool: "remove_note", error: { code: -32602, message: "Unknown tool: remove_note" } });
    expect(refused!.result).toBeUndefined();
    expect(step("the server wrote nothing for it").status).toBe("passed");

    // Over stdio the call carries the trace context only in `_meta`; the
    // server posts to the world with it, so the world's lines are the
    // step's, and no line closes the call itself.
    const eggs = step('the agent adds the note "eggs" over stdio');
    const [piped] = jsonLines<McpCallLine>(rootDir, eggs, "mcp.jsonl");
    const pipedSpan = spanOf(piped!.traceparent, eggs.observed.events!.trace_id);
    expect(pipedSpan).toBeDefined();
    expect(piped!.header_sent_to).toBeUndefined();
    expect(eggs.observed.http).toBeNull();
    expect(eggs.observed.events).toMatchObject({ kinds: { db: 1, request: 1 }, stamped_spans: [], mcp_spans: [pipedSpan], whole: false, open: [{ gap: "mcp-unbounded", calls: 1 }] });
    expect(step("the stdio call inserted at least 1 note").status).toBe("passed");
  });

  it("leaves an exact count of a stdio call's writes unjudged, and says why", async () => {
    const result = await cli(rootDir, ["run", "features/stdio-exact.feature"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("are not whole (mcp-unbounded): 1 MCP call of the step went to its server by a way no line reports the end of");
    expect(readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8")).toContain("(mcp-unbounded)");
  });

});
