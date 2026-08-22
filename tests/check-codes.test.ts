import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listCheckCodes } from "../src/check/codes.js";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: `nuka check --codes` answers "what can this catch" on its
// own, independent of any one project's own findings (`--json` alone
// answers "what is wrong with this project", a different question) — the
// gap a migrating agent hit against the published README, which pointed at
// `nuka check --json` for a code catalog that command has never produced
// (only `{ errors, warnings }` for the current project).
// `check-clean-project` is reused for every case here on purpose: `--codes`
// must answer the same way regardless of which project it is run from, so
// picking the fixture with the least going on makes that independence
// visible rather than incidental.

describe("nuka check --codes", () => {
  it("--codes --json lists every finding code, including step-file-import-failed", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--codes", "--json"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const codes = JSON.parse(stdout.text()) as Array<{ code: string; description: string; severity?: string }>;
    expect(codes.some((entry) => entry.code === "step-file-import-failed")).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("every registered code has a non-empty description", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--codes", "--json"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const codes = JSON.parse(stdout.text()) as Array<{ code: string; description: string }>;
    expect(codes.length).toBeGreaterThan(0);
    for (const entry of codes) {
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("--codes --json is sorted by code, ascending", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--codes", "--json"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const codes = JSON.parse(stdout.text()) as Array<{ code: string }>;
    const sorted = [...codes].map((entry) => entry.code).sort((a, b) => a.localeCompare(b));
    expect(codes.map((entry) => entry.code)).toEqual(sorted);
  });

  it("--codes without --json prints one human-readable line per code, code ascending", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--codes"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const lines = stdout.text().trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes("step-file-import-failed"))).toBe(true);
    const codesInOutput = lines.map((line) => line.split("\t")[0]);
    const sorted = [...codesInOutput].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(codesInOutput).toEqual(sorted);
    expect(exitCode).toBe(0);
  });

  it("does not run project analysis: --codes exits 0 even against a project with errors", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--codes", "--json"], {
      rootDir: fixture("check-errors-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    expect(exitCode).toBe(0);
    const codes = JSON.parse(stdout.text()) as Array<{ code: string }>;
    expect(codes.some((entry) => entry.code === "step-file-import-failed")).toBe(true);
  });

  it("answers even against a project whose config fails to load, unlike --json alone", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--codes", "--json"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    expect(exitCode).toBe(0);
    const codes = JSON.parse(stdout.text()) as Array<{ code: string }>;
    expect(codes.some((entry) => entry.code === "step-file-import-failed")).toBe(true);
  });

  // The registry's type keeps an unregistered code from compiling. This is
  // the same guarantee pointed the other way: a code that stays registered
  // after the check that raised it is gone would leave `--codes`
  // advertising something this tool can no longer find, which is worse than
  // a missing entry because a reader cannot tell the difference from the
  // outside. Every registered code has to appear as a literal in the source
  // that raises it.
  it("registers no code that nothing in src/ can raise", async () => {
    const sources = await collectSourceFiles(path.join(repoRoot, "src"));
    const bodies = await Promise.all(
      sources
        .filter((file) => !file.endsWith(path.join("check", "codes.ts")))
        .map((file) => readFile(file, "utf8")),
    );
    const haystack = bodies.join("\n");

    const unraisable = listCheckCodes()
      .map((entry) => entry.code)
      .filter((code) => !haystack.includes(`"${code}"`));

    expect(unraisable).toEqual([]);
  });
});

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectSourceFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}
