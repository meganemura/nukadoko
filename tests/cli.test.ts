import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

describe("nuka steps", () => {
  it("lists the vocabulary as JSON: name, patterns, description, mutates", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const summaries = JSON.parse(stdout.text());
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "create-project",
          patterns: ["a project {string} exists"],
          description: "Create a project and return its id",
          mutates: true,
        }),
        expect.objectContaining({
          name: "list-projects",
          patterns: [],
          mutates: false,
        }),
      ]),
    );
    expect(summaries).toHaveLength(3);
  });

  it("propagates a ConfigError as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("typo");
  });
});

describe("nuka describe", () => {
  it("prints args/returns as JSON Schema", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "create-project"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const contract = JSON.parse(stdout.text());
    expect(contract.name).toBe("create-project");
    expect(contract.mutates).toBe(true);
    expect(contract.args).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(contract.returns).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      required: expect.arrayContaining(["id", "name"]),
    });
  });

  it("exits 1 with a stderr message for an unknown step name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "no-such-step"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no-such-step");
  });
});

describe("nuka (process)", () => {
  it("runs end-to-end via tsx against a fixture project", async () => {
    const cliPath = path.join(repoRoot, "src", "cli.ts");
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

    const { stdout, stderr } = await execFileAsync(tsxBin, [cliPath, "steps", "--json"], {
      cwd: fixture("basic-project"),
    });

    expect(stderr).toBe("");
    const summaries = JSON.parse(stdout);
    expect(summaries.map((s: { name: string }) => s.name).sort()).toEqual([
      "create-project",
      "get-project",
      "list-projects",
    ]);
  });
});
