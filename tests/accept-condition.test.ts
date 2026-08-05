import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, initGitRepo, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: `nuka accept`'s sign-off condition end to end
// (accept-condition task spec) — (environment, browser) as a measured
// tuple, never a declaration, against accept-condition-project: an
// API-only feature (features/greeting.feature, no browser, no HTTP server)
// paired with one that destructures `page` (features/browser.feature,
// chromium only — this task's spec: tests must not depend on firefox/webkit
// binaries, which are not installed here). Wherever a test needs config to
// *declare* an engine nukadoko never actually launches, it writes that
// declaration before `nuka accept` only — `accept` never executes anything
// (docs/spec.md "Sign-off"), so declaring "firefox" here is always safe.

const execFileAsync = promisify(execFile);

async function commitAll(dir: string, message: string): Promise<string> {
  const git = (args: string[]) => execFileAsync("git", args, { cwd: dir, encoding: "utf8" });
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", message]);
  const { stdout } = await git(["rev-parse", "HEAD"]);
  return stdout.trim();
}

function frontmatterText(markdown: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!match) throw new Error("no frontmatter block found in record");
  return match[1]!;
}

describe("nuka accept: condition (accept-condition task spec)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-condition-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("accepts the same feature at the same commit under two different conditions without either record overwriting the other", async () => {
    await initGitRepo(rootDir);

    const run1Exit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(run1Exit).toBe(0);

    const accept1Stdout = createCaptureSink();
    const accept1Exit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout: accept1Stdout,
      stderr: createCaptureSink(),
    });
    expect(accept1Exit).toBe(0);
    const path1 = accept1Stdout.text().trim();
    expect(path1).toMatch(/\.default\.no-browser\.md$/);

    // A real delay so the second run's own `started_at` is unambiguously
    // later than the first's (src/accept/select-run.ts picks the most
    // recent full green run) — the same reasoning tests/accept.test.ts's
    // own overwrite-semantics test already uses.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const run2Exit = await runCli(["run", "features/greeting.feature", "--env", "staging"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(run2Exit).toBe(0);

    const accept2Stdout = createCaptureSink();
    const accept2Stderr = createCaptureSink();
    const accept2Exit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout: accept2Stdout,
      stderr: accept2Stderr,
    });
    expect(accept2Exit).toBe(0);
    expect(accept2Stderr.text()).toBe("");
    const path2 = accept2Stdout.text().trim();
    expect(path2).toMatch(/\.staging\.no-browser\.md$/);
    expect(path2).not.toBe(path1);

    // Both records still exist, each carrying its own condition — the
    // second accept must not have touched the first.
    const content1 = await readFile(path.join(rootDir, path1), "utf8");
    expect(frontmatterText(content1)).toContain("environment: default");
    const content2 = await readFile(path.join(rootDir, path2), "utf8");
    expect(frontmatterText(content2)).toContain("environment: staging");
  });

  it("a run that launched no browser is a candidate no matter what browserType the config currently declares", async () => {
    // Written before the commit below, so declaring "firefox" (never
    // actually launched — greeting.feature never destructures page) never
    // makes the working tree dirty at accept time.
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        'export default defineConfig({ environments: { staging: {} }, browserType: "firefox" });',
        "",
      ].join("\n"),
    );
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/greeting.feature"], { rootDir, stdout, stderr });

    expect(stderr.text()).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.text().trim()).toMatch(/\.no-browser\.md$/);
  });

  it("refuses when no green full run exists under the current condition, naming the condition(s) that do have one", async () => {
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/browser.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    // The only green full run of features/browser.feature measured
    // chromium (this fixture's own config default). Declaring firefox now
    // — committed, so the tree stays clean for refusal condition 3 — leaves
    // no run matching the *current* condition, even though a green full run
    // exists under a different one.
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        'export default defineConfig({ environments: { staging: {} }, browserType: "firefox" });',
        "",
      ].join("\n"),
    );
    await commitAll(rootDir, "declare firefox");

    const stderr = createCaptureSink();
    const exitCode = await runCli(["accept", "features/browser.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("no green full run of features/browser.feature exists under the current condition (browser: firefox)");
    expect(stderr.text()).toContain("Runs exist for: environment default, browser chromium");
  });

  it("writes the accepted run's own condition into the record body, stating explicitly when no browser was launched", async () => {
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/greeting.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stdout = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/greeting.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(acceptExit).toBe(0);

    const content = await readFile(path.join(rootDir, stdout.text().trim()), "utf8");
    expect(content).toContain("## Condition");
    expect(content).toContain("- environment: default");
    // Explicit, never a blank line (task spec item 5's own "空欄にしない") —
    // "condition unknown" (an old record) must stay distinguishable from
    // "condition known: no browser" (this one).
    expect(content).toContain("- browser: not launched (no step in this run destructured page/context)");
  });

  it("writes the accepted run's own measured engine and version into the record body when a browser was launched", async () => {
    await initGitRepo(rootDir);

    const runExit = await runCli(["run", "features/browser.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(runExit).toBe(0);

    const stdout = createCaptureSink();
    const acceptExit = await runCli(["accept", "features/browser.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    expect(acceptExit).toBe(0);

    const relativePath = stdout.text().trim();
    expect(relativePath).toMatch(/\.default\.chromium\.md$/);

    const content = await readFile(path.join(rootDir, relativePath), "utf8");
    expect(content).toMatch(/- browser: chromium \S+/);
    // The engine's type is enough for acceptance/matching purposes (task
    // spec item 2) — the version is informational only, and belongs in the
    // body, never the filename.
    expect(frontmatterText(content)).toContain("browser: chromium");
  });
});
