import { writeFile } from "node:fs/promises";
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
} from "./helpers/fixtures.js";

// Responsibility: anti-rot proof for examples/todo/README.md's two central,
// checkable claims (examples-todo task spec, deliverable 4) -- run the
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
    const exitCode = await runCli(["run", "features/todo.feature"], { rootDir, stdout, stderr });

    expect(stderr.text()).toBe("");
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
    const exitCode = await runCli(["run", "features/todo.feature"], { rootDir, stdout, stderr });

    const records = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { status: string });
    expect(records.some((record) => record.status === "failed")).toBe(true);
    expect(exitCode).toBe(1);
  });
});
