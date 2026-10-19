import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka steps --json` and `nuka describe` exit 1 when part
// of a step's contract could not be read (its needs, a from entry, an args
// or returns schema JSON Schema cannot represent), and say so with one
// `contract-unreadable` finding that names the step, so a reader that
// switches on `findings` is not left with a failed verdict and nothing
// in it.

interface Envelope {
  readonly verdict: string;
  readonly findings: ReadonlyArray<{ readonly severity: string; readonly code: string; readonly file?: string; readonly step?: string; readonly message: string }>;
}

async function json(argv: string[], project: string): Promise<{ exitCode: number; document: Envelope }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(argv, { rootDir: fixture(project), stdout, stderr: createCaptureSink() });
  return { exitCode, document: JSON.parse(stdout.text()) as Envelope };
}

function unreadable(document: Envelope) {
  return document.findings.filter((finding) => finding.code === "contract-unreadable").map(({ severity, step, file }) => ({ severity, step, file }));
}

describe("contract-unreadable", () => {
  it("names each step with an unreadable from entry in nuka steps --json", async () => {
    const { exitCode, document } = await json(["steps", "--json"], "from-malformed-entry-project");
    expect(exitCode).toBe(1);
    expect(document.verdict).toBe("failed");
    expect(unreadable(document).map((finding) => finding.step)).toEqual(["bad-object", "bad-string"]);
    expect(unreadable(document)[0]!.severity).toBe("failed");
  });

  it("names a step whose needs could not be read", async () => {
    const { document } = await json(["describe", "legacy-basic"], "needs-inferred-project");
    expect(document.verdict).toBe("failed");
    const [finding] = document.findings.filter((entry) => entry.code === "contract-unreadable");
    expect(finding!.step).toBe("legacy-basic");
    expect(finding!.message.startsWith("legacy-basic: needs could not be read: A step's run() must destructure its first argument")).toBe(true);
  });

  it("names a step whose args schema JSON Schema cannot represent, in nuka describe", async () => {
    const { exitCode, document } = await json(["describe", "note-moment"], "unrepresentable-schema-project");
    expect(exitCode).toBe(1);
    const [finding] = document.findings.filter((entry) => entry.code === "contract-unreadable");
    expect(finding!.step).toBe("note-moment");
    expect(finding!.message).toContain("Date cannot be represented in JSON Schema");
  });
});
