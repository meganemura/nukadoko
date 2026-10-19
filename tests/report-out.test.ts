import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir, withoutNoConfigLine } from "./helpers/fixtures.js";

// Responsibility: what `nuka report --out` does with a target that cannot
// hold the render: a fast `report-out-invalid` refusal that says what is
// in the way, never a hang (a path under /proc once spun at full CPU in
// Node's recursive mkdir) and never `unexpected-error`. A missing
// directory on the way is created.

const FIX = "  fix: Name a regular file for markdown and messages, or a directory for allure, under a directory that exists or can be created.\n  do: nuka report --help\n";

describe("nuka report --out", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
    expect(await runCli(["run", "--no-check", "features/passing.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() })).toBe(0);
    writeFileSync(path.join(rootDir, "afile.txt"), "x");
    mkdirSync(path.join(rootDir, "adir"));
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  async function report(format: string, out: string): Promise<{ exitCode: number; stderr: string }> {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["report", "--format", format, "--out", out], { rootDir, stdout: createCaptureSink(), stderr });
    return { exitCode, stderr: withoutNoConfigLine(stderr.text()) };
  }

  it.each([
    ["markdown", "adir", "--out adir is a directory; markdown and messages write one file"],
    ["messages", "afile.txt/x.ndjson", "--out afile.txt/x.ndjson lies under afile.txt, which is not a directory"],
    ["allure", "afile.txt", "--out afile.txt is not a directory; allure writes a directory of results"],
    ["allure", "afile.txt/sub", "--out afile.txt/sub lies under afile.txt, which is not a directory"],
  ])("refuses --format %s --out %s", async (format, out, message) => {
    expect(await report(format, out)).toEqual({ exitCode: 2, stderr: `refused\treport-out-invalid\t-\t${message}\n${FIX}` });
  });

  it.runIf(process.platform !== "win32")("refuses a FIFO instead of blocking on it", async () => {
    execFileSync("mkfifo", [path.join(rootDir, "afifo")]);
    expect(await report("markdown", "afifo")).toEqual({
      exitCode: 2,
      stderr: `refused\treport-out-invalid\t-\t--out afifo is not a regular file (a FIFO, a socket, or a device), so it is not written\n${FIX}`,
    });
  });

  it.runIf(process.platform === "linux" && existsSync("/proc/self"))("refuses a directory under /proc at once instead of spinning", async () => {
    const started = Date.now();
    expect(await report("allure", "/proc/nukadoko-nope")).toEqual({
      exitCode: 2,
      stderr: `refused\treport-out-invalid\t-\t--out /proc/nukadoko-nope: could not create /proc/nukadoko-nope (ENOENT)\n${FIX}`,
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("creates the missing directories a file target needs", async () => {
    const { exitCode } = await report("markdown", "new/deep/summary.md");
    expect(exitCode).toBe(0);
    expect(readFileSync(path.join(rootDir, "new", "deep", "summary.md"), "utf8")).toContain("# nukadoko run passed");
  });
});
