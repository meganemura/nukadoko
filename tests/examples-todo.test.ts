import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoApp } from "../examples/todo/app/server.js";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyExampleToTempDir,
  createCaptureSink,
  ensureNukadokoShim,
  removeTempDir,
  repoRoot,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: anti-rot proof for examples/todo/README.md's two central,
// checkable claims -- run the
// actual example project against the actual app, in both its v1 and v2
// shape, so the walkthrough's story ("the feature runs green" / "the field
// rename breaks it") can't silently stop being true. Only that mechanical
// claim is asserted here; the repair loop itself (README.md, Part 2) is
// prose an agent enacts by hand, not something this suite re-derives.

function startTodoApp(options: { v2?: boolean } = {}): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createTodoApp(options);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

// The committed config points at the fixed port the README tells a human
// reader to use (http://localhost:4000); this test needs an ephemeral one
// instead, so it overwrites the temp copy's config the same way
// run-browser.test.ts does for its own fixture.
async function pointConfigAt(rootDir: string, baseURL: string): Promise<void> {
  await writeFile(
    path.join(rootDir, "nukadoko.config.ts"),
    [
      'import { defineConfig } from "nukadoko";',
      "",
      `export default defineConfig({ baseURL: "${baseURL}" });`,
      "",
    ].join("\n"),
  );
}

describe("examples/todo", () => {
  let server: Server;
  let rootDir: string;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("runs features/todo.feature green against the v1 app", async () => {
    const started = await startTodoApp({ v2: false });
    server = started.server;
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();
    await pointConfigAt(rootDir, started.baseURL);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "features/todo.feature"], { rootDir, stdout, stderr });

    expect(stripRunProgressLines(stderr.text())).toBe("");
    const records = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { status: string });
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.status).toBe("passed");
    }
    expect(exitCode).toBe(0);
  });

  it("fails the same feature against the v2 app (the field rename breaks it)", async () => {
    const started = await startTodoApp({ v2: true });
    server = started.server;
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();
    await pointConfigAt(rootDir, started.baseURL);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "features/todo.feature"], { rootDir, stdout, stderr });

    const records = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { status: string });
    expect(records.some((record) => record.status === "failed")).toBe(true);
    expect(exitCode).toBe(1);
  });

  it("runs features/todo.md green against the v1 app", async () => {
    const started = await startTodoApp({ v2: false });
    server = started.server;
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();
    await pointConfigAt(rootDir, started.baseURL);

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "features/todo.md"], { rootDir, stdout, stderr });

    expect(stripRunProgressLines(stderr.text()), stderr.text()).toBe("");
    const records = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { status: string });
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(record.status).toBe("passed");
    }
    expect(exitCode).toBe(0);
  });
});

describe("examples/todo oath check", () => {
  let rootDir: string;

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("nuka check is clean for the committed feature and its Markdown oath", async () => {
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check"], { rootDir, stdout, stderr });

    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("ok: no issues found");
    expect(exitCode).toBe(0);
  });
});

// README.md's Part 1 shows two outputs a reader compares with their own
// terminal: what `nuka check` prints once the step is set aside, and what
// the scaffold command writes. Both come from running the commands here, so
// neither can drift from what the CLI prints today. The implemented step it
// then shows is the file the example ships.
describe("examples/todo README, Part 1", () => {
  let rootDir: string;

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  // The first fenced block of `lang` after `marker` in the README.
  function blockAfter(readme: string, marker: string, lang: string): string {
    const at = readme.indexOf(marker);
    expect(at, marker).toBeGreaterThan(-1);
    const open = readme.indexOf("```" + lang + "\n", at);
    const start = open + lang.length + 4;
    return readme.slice(start, readme.indexOf("```\n", start));
  }

  it("shows the check output, the scaffold output, and the shipped step as they are", async () => {
    const readme = await readFile(path.join(repoRoot, "examples", "todo", "README.md"), "utf8");
    expect(readme).toContain("mv features/steps/complete-todo.ts /tmp/complete-todo.ts.bak\nmv features/explore /tmp/explore.bak\n");
    rootDir = await copyExampleToTempDir("todo");
    await ensureNukadokoShim();
    await rm(path.join(rootDir, "features", "steps", "complete-todo.ts"));
    await rename(path.join(rootDir, "features", "explore"), path.join(rootDir, "explore.bak"));

    const checkOut = createCaptureSink();
    const checkCode = await runCli(["check"], { rootDir, stdout: checkOut, stderr: createCaptureSink() });
    expect(checkOut.text()).toBe(blockAfter(readme, "**4.", "text"));
    expect(checkCode).toBe(1);

    const scaffold = blockAfter(readme, "**5. Scaffold it:**", "sh").trim();
    expect(scaffold).toBe('nuka scaffold complete-todo --pattern "the todo titled {title:string} is completed"');
    const scaffoldCode = await runCli(
      ["scaffold", "complete-todo", "--pattern", "the todo titled {title:string} is completed"],
      { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() },
    );
    expect(scaffoldCode).toBe(0);
    const written = await readFile(path.join(rootDir, "features", "steps", "complete-todo.ts"), "utf8");
    expect(written).toBe(blockAfter(readme, "**5. Scaffold it:**", "ts"));

    const shipped = await readFile(path.join(repoRoot, "examples", "todo", "features", "steps", "complete-todo.ts"), "utf8");
    expect(blockAfter(readme, "**6. Implement it.**", "ts")).toBe(shipped);
  });
});
