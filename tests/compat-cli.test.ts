import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: m2a-compat-registry task spec's CLI static-surface tests —
// `nuka steps`/`nuka describe`/`nuka do` all need to know a vocabulary entry
// can be `kind: "compat"` (docs/spec.md "CLI summary": "list the whole
// vocabulary, typed and compat").

describe("nuka steps: compat entries", () => {
  it("--json shows kind: \"compat\" and omits description/mutates for a compat entry", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("compat-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const summaries = JSON.parse(stdout.text()) as Array<Record<string, unknown>>;
    expect(summaries).toHaveLength(3);
    for (const s of summaries) {
      expect(s.kind).toBe("compat");
      expect(s).not.toHaveProperty("description");
      expect(s).not.toHaveProperty("mutates");
    }
    expect(summaries.map((s) => s.name).sort()).toEqual(
      [
        "compat: a legacy project {string} exists",
        "compat: the legacy result is {string}",
        "compat: /^a legacy request is made$/",
      ].sort(),
    );
  });

  it("human-readable output is one heading-only block per compat entry, no pattern line", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps"], {
      rootDir: fixture("compat-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    // Blocks are blank-line separated (steps-human-output task spec); a
    // compat entry is heading-only, so each block here is exactly one line.
    const blocks = stdout.text().replace(/\n$/, "").split("\n\n");
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block).not.toContain("\n");
      expect(block.endsWith("  compat")).toBe(true);
      expect(block.startsWith("compat: ")).toBe(true);
    }
  });
});

describe("nuka describe: compat entries", () => {
  it("describes a compat entry with kind, pattern, and a promotion message instead of schemas", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["describe", "compat: a legacy project {string} exists"],
      { rootDir: fixture("compat-project"), stdout, stderr },
    );

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const contract = JSON.parse(stdout.text());
    expect(contract.kind).toBe("compat");
    expect(contract.pattern).toBe("a legacy project {string} exists");
    expect(contract.message).toContain("defineStep");
    expect(contract.args).toBeUndefined();
    expect(contract.returns).toBeUndefined();
  });
});

describe("nuka do: compat entries cannot be named", () => {
  it("exits 1 with a promotion-guidance message and writes no receipt", async () => {
    const rootDir = await copyFixtureToTempDir("compat-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        [
          "do",
          "compat: a legacy project {string} exists",
          "--args",
          "{}",
        ],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain("compat step");
      expect(stderr.text()).toContain("defineStep");
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
