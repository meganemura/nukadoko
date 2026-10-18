import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: pins the exact wording of two `nuka tend` messages whose
// claims must match what the code does: only a capture fills a `from` key,
// and tend scans more than `featuresDir`.

async function tendNotes(project: string): Promise<Array<{ code: string; step?: string; message: string }>> {
  const stdout = createCaptureSink();
  await runCli(["tend", "--json"], { rootDir: fixture(project), stdout, stderr: createCaptureSink() });
  return bySeverity(stdout.text()).notes;
}

describe("nuka tend message wording", () => {
  it("from-unused names a pattern capture as the only filler", async () => {
    const notes = await tendNotes("tend-findings-project");
    const note = notes.find((issue) => issue.code === "from-unused");
    expect(note?.message).toBe(
      `Step "orphan-from-step"'s from.id declares a producer, but every bound occurrence of this step already fills "id" from a pattern capture. That producer has never supplied it. Still reachable through \`nuka do --use\`; this is a fact, not a verdict on whether to remove it.`,
    );
  });

  it("pattern-unbound says the scanned directories, not featuresDir", async () => {
    const notes = await tendNotes("tend-findings-project");
    const note = notes.find((issue) => issue.code === "pattern-unbound");
    expect(note?.message).toBe(
      `Step "unbound-step" declares a pattern, but no feature line under the scanned directories binds it. It has no place in any scenario right now.`,
    );
  });
});
