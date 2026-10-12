import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { findImportFailuresUnseen } from "../src/tend/import-failures-unseen.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: pins the exact wording of three `nuka tend` messages whose
// claims must match what the code does: only a capture fills a `from` key,
// tend scans more than `featuresDir`, and the verb agrees with the count.

async function tendNotes(project: string): Promise<Array<{ code: string; step?: string; message: string }>> {
  const stdout = createCaptureSink();
  await runCli(["tend", "--json"], { rootDir: fixture(project), stdout, stderr: createCaptureSink() });
  return JSON.parse(stdout.text()).notes;
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

  it("import-failures-unseen agrees the verb with the count", () => {
    const one = findImportFailuresUnseen([{ filePath: "a.ts", message: "x" }]);
    expect(one.map((issue) => issue.message)).toEqual([
      `this report only sees steps that imported successfully; 1 step file could not be read and is missing from every count and finding here (run "nuka check" for detail): a.ts`,
    ]);
    const two = findImportFailuresUnseen([
      { filePath: "a.ts", message: "x" },
      { filePath: "b.ts", message: "y" },
    ]);
    expect(two.map((issue) => issue.message)).toEqual([
      `this report only sees steps that imported successfully; 2 step files could not be read and are missing from every count and finding here (run "nuka check" for detail): a.ts, b.ts`,
    ]);
  });
});
