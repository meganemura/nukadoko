import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: fb5-loader-visibility task spec, decision 4 — `nuka tend`
// discovers steps tolerant of a broken glue file (unchanged), but until now
// said nothing about it: this pins down that exactly one note is added
// (never one per broken file — a per-file verdict is `check`'s own finding,
// not tend's), and that the exit code stays 0 (a note never fails `nuka
// tend`, docs/spec.md "Tending"). tests/fixtures/check-import-failure-project
// already carries exactly one file that fails to import
// (features/steps/broken.ts).

describe("nuka tend: notes when a step file could not be imported", () => {
  it("adds exactly one import-failures-unseen note, naming the file, without touching the exit code", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("check-import-failure-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      errors: unknown[];
      notes: Array<{ code: string; message: string }>;
    };
    const unseenNotes = report.notes.filter((note) => note.code === "import-failures-unseen");
    expect(unseenNotes).toHaveLength(1);
    expect(unseenNotes[0]?.message).toContain("features/steps/broken.ts");
    expect(unseenNotes[0]?.message).toContain("nuka check");

    // The finding is a note, not an error: exit code is unaffected by it.
    expect(report.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("adds no import-failures-unseen note when nothing failed to import", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["tend", "--json"], {
      rootDir: fixture("tend-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as { notes: Array<{ code: string }> };
    expect(report.notes.some((note) => note.code === "import-failures-unseen")).toBe(false);
    expect(exitCode).toBe(0);
  });
});
