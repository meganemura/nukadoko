import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { readOwnVersion } from "../src/version.js";
import { createCaptureSink, createEmptyTempDir, removeTempDir, repoRoot } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

// Responsibility: src/version.ts's readOwnVersion(), and the two places it
// feeds (own-version task spec) — `nuka --version` (src/cli/run-cli.ts) and
// the cucumber-messages `Meta.implementation.version` field (covered
// instead in messages-emitter.test.ts, alongside that emitter's other
// fields, rather than duplicated here).
//
// The actual bug this task fixes only shows up across a process boundary:
// yargs' own default version resolution walks up from `process.cwd()`, so a
// unit-level `runCli()` call — which never spawns a process or changes
// `cwd` — can't reproduce it. The "does not print the caller's own
// package.json version" test below spawns a real child process with `cwd`
// pointed at a decoy project, the same way skill.test.ts's own "process"
// block exercises both entry points (dist/cli.js and src/cli.ts via tsx).

describe("readOwnVersion", () => {
  it("matches nukadoko's own package.json version field", async () => {
    const raw = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version: string };
    expect(readOwnVersion()).toBe(pkg.version);
  });
});

describe("nuka --version", () => {
  it("exits 0 without a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["--version"], { stdout, stderr });
    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
  });

  it("resolves the same version from dist/cli.js as from src/cli.ts via tsx, and it matches package.json", async () => {
    const raw = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version: string };

    const cliPath = path.join(repoRoot, "dist", "cli.js");
    const { stdout: distStdout, stderr: distStderr } = await execFileAsync(process.execPath, [
      cliPath,
      "--version",
    ]);
    expect(distStderr).toBe("");

    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
    const tsxCliPath = path.join(repoRoot, "src", "cli.ts");
    const { stdout: tsxStdout, stderr: tsxStderr } = await execFileAsync(tsxBin, [tsxCliPath, "--version"]);
    expect(tsxStderr).toBe("");

    expect(distStdout.trim()).toBe(pkg.version);
    expect(tsxStdout.trim()).toBe(pkg.version);
  });

  it("does not print the caller's own package.json version (the bug this task fixes)", async () => {
    const raw = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version: string };

    const decoyDir = await createEmptyTempDir();
    try {
      await writeFile(
        path.join(decoyDir, "package.json"),
        `${JSON.stringify({ name: "decoy", private: true, version: "9.9.9" }, null, 2)}\n`,
      );

      const cliPath = path.join(repoRoot, "dist", "cli.js");
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--version"], {
        cwd: decoyDir,
      });

      expect(stderr).toBe("");
      expect(stdout.trim()).toBe(pkg.version);
      expect(stdout.trim()).not.toBe("9.9.9");
    } finally {
      await removeTempDir(decoyDir);
    }
  });
});
