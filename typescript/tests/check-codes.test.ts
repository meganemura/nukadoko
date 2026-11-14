import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listCheckCodes } from "../src/check/codes.js";
import { listRefusalCodes } from "../src/cli/refusal-codes.js";
import { parseFindings } from "../src/finding/finding.js";
import { listRunCodes } from "../src/finding/run-codes.js";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: `nuka check --codes` answers "what can this catch" on its
// own, independent of any one project's own findings (`--json` alone
// answers "what is wrong with this project", a different question) — the
// gap a migrating agent hit against the published README, which pointed at
// `nuka check --json` for a code catalog that command has never produced
// (only the findings of the current project).
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
    const codes = JSON.parse(stdout.text()).codes as Array<{ code: string; message: string; severity: string }>;
    expect(codes.some((entry) => entry.code === "step-file-import-failed")).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("every registered code has a non-empty description and fix", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--codes", "--json"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const codes = JSON.parse(stdout.text()).codes as Array<{ code: string; message: string; fix: string }>;
    expect(codes.length).toBeGreaterThan(0);
    for (const entry of codes) {
      expect(typeof entry.message).toBe("string");
      expect(entry.message.length).toBeGreaterThan(0);
      expect(entry.fix.length).toBeGreaterThan(0);
    }
  });

  it("--codes --json is sorted by code, ascending", async () => {
    const stdout = createCaptureSink();
    await runCli(["check", "--codes", "--json"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const codes = JSON.parse(stdout.text()).codes as Array<{ code: string }>;
    const sorted = [...codes].map((entry) => entry.code).sort((a, b) => a.localeCompare(b));
    expect(codes.map((entry) => entry.code)).toEqual(sorted);
  });

  it("--codes without --json prints one note-shaped finding per code, code ascending", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--codes"], {
      rootDir: fixture("check-clean-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const findings = parseFindings(stdout.text());
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.fix !== undefined)).toBe(true);
    const codesInOutput = findings.map((finding) => finding.code);
    expect(codesInOutput).toContain("step-file-import-failed");
    expect(codesInOutput).toEqual([...codesInOutput].sort((a, b) => a.localeCompare(b)));
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
    const codes = JSON.parse(stdout.text()).codes as Array<{ code: string }>;
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
    const codes = JSON.parse(stdout.text()).codes as Array<{ code: string }>;
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
    const registries = [path.join("check", "codes.ts"), path.join("run", "codes.ts"), path.join("cli", "refusal-codes.ts")];
    const sources = await collectSourceFiles(path.join(repoRoot, "src"));
    const bodies = await Promise.all(
      sources
        .filter((file) => !registries.some((registry) => file.endsWith(registry)))
        .map((file) => readFile(file, "utf8")),
    );
    const haystack = bodies.join("\n");

    const unraisable = [...listCheckCodes(), ...listRunCodes(), ...listRefusalCodes()]
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
