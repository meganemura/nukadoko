import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  fixture,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: README's
// "Before / after" section claims three things about promoting a step from
// cucumber-js glue to a typed `defineStep`, and until this file neither
// snippet it shows ever actually ran anywhere in the repo. This makes all
// three claims executable against two real fixture projects
// (promotion-glue-project / promotion-typed-project) sharing one
// byte-identical feature file and differing only in their step
// definitions:
//
//   1. the feature line's text doesn't change, only the step definition
//      behind it does — asserted here as the two projects'
//      features/promote.feature being byte-identical, and both `nuka run`
//      invocations reporting the same scenario status
//   2. named capture + zod validate `result` — asserted as: the typed
//      step record's result has the server response's extra, undeclared key
//      stripped (zod's parsed output, not the raw response); the compat
//      step's own step record result is always null
//   3. only the typed side runs standalone via `nuka do`; the compat step
//      is refused by name (docs/spec.md "Compat steps")
//
// This is a different axis than selftest-suite/ (this repo's own root),
// which compares "the same code under two runtimes" (the compat door) —
// this compares "the same feature line under two implementations"
// (promotion).

function startTestServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/projects") {
        res.writeHead(200, { "content-type": "application/json" });
        // `leaked` only ever reaches a step record's `result` if something
        // skips the typed side's zod `returns` schema. It isn't an
        // argument or a fixture, only ever present on the wire — that's
        // what makes claim 2 ("result... is something the tool validated")
        // checkable here rather than only asserted.
        res.end(JSON.stringify({ id: "p-1", name: "acme", leaked: "not-in-schema" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function pointConfigAt(rootDir: string, baseURL: string): Promise<void> {
  await writeFile(
    path.join(rootDir, "nukadoko.config.ts"),
    [
      'import { defineConfig } from "./nukadoko-shim.js";',
      `export default defineConfig({ baseURL: "${baseURL}" });`,
      "",
    ].join("\n"),
  );
}

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

describe("README claim 1: the feature line doesn't change across the promotion", () => {
  it("promotion-glue-project and promotion-typed-project's features/promote.feature are byte-identical", async () => {
    const glueBytes = await readFile(
      path.join(fixture("promotion-glue-project"), "features", "promote.feature"),
    );
    const typedBytes = await readFile(
      path.join(fixture("promotion-typed-project"), "features", "promote.feature"),
    );
    expect(Buffer.compare(glueBytes, typedBytes)).toBe(0);
  });
});

describe("README claims 1 and 2: `nuka run` against both projects", () => {
  let server: Server;
  let baseURL: string;
  let glueRoot: string;
  let typedRoot: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    glueRoot = await copyFixtureToTempDir("promotion-glue-project");
    typedRoot = await copyFixtureToTempDir("promotion-typed-project");
    await pointConfigAt(glueRoot, baseURL);
    await pointConfigAt(typedRoot, baseURL);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(glueRoot);
    await removeTempDir(typedRoot);
  });

  it("both `nuka run` invocations report the same scenario status (claim 1)", async () => {
    const glueStdout = createCaptureSink();
    const glueStderr = createCaptureSink();
    const glueExit = await runCli(["run", "features/promote.feature"], {
      rootDir: glueRoot,
      stdout: glueStdout,
      stderr: glueStderr,
    });

    const typedStdout = createCaptureSink();
    const typedStderr = createCaptureSink();
    const typedExit = await runCli(["run", "features/promote.feature"], {
      rootDir: typedRoot,
      stdout: typedStdout,
      stderr: typedStderr,
    });

    expect(stripRunProgressLines(glueStderr.text())).toBe("");
    expect(stripRunProgressLines(typedStderr.text())).toBe("");

    const glueRecord = JSON.parse(nonEmptyLines(glueStdout.text())[0]!);
    const typedRecord = JSON.parse(nonEmptyLines(typedStdout.text())[0]!);

    expect(glueExit).toBe(typedExit);
    expect(glueRecord.status).toBe(typedRecord.status);
    // Reported as actually measured (a mismatch against
    // README gets reported, not folded into a looser assertion) — both
    // runs are expected to pass against the fake server above.
    expect(typedRecord.status).toBe("passed");
  });

  it("only the typed step's step record carries a validated result; the compat step's step record result is always null (claim 2)", async () => {
    const glueStdout = createCaptureSink();
    await runCli(["run", "features/promote.feature"], {
      rootDir: glueRoot,
      stdout: glueStdout,
      stderr: createCaptureSink(),
    });
    const glueRecord = JSON.parse(nonEmptyLines(glueStdout.text())[0]!);
    const glueStepRecord = await readStepRecord(glueRoot, glueRecord.steps[0].step_record_id);
    expect(glueStepRecord.result).toBeNull();

    const typedStdout = createCaptureSink();
    await runCli(["run", "features/promote.feature"], {
      rootDir: typedRoot,
      stdout: typedStdout,
      stderr: createCaptureSink(),
    });
    const typedRecord = JSON.parse(nonEmptyLines(typedStdout.text())[0]!);
    const typedStepRecord = await readStepRecord(typedRoot, typedRecord.steps[0].step_record_id);
    // The server's response includes an extra `leaked` key that isn't in
    // the `returns` schema; if `result` were the raw response, it would
    // include it. It's absent because `result` is zod's *parsed* output
    // (src/run/run-scenario.ts: `result = returnsResult.data`), not the
    // step's raw return value — this is what "validated" cashes out to.
    expect(typedStepRecord.result).toEqual({ id: "p-1", name: "acme" });
  });
});

describe("README claim 3: `nuka do` runs the typed step standalone and refuses the compat step by name", () => {
  let server: Server;
  let baseURL: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("`nuka do create-project` runs the typed step and returns a validated result", async () => {
    const rootDir = await copyFixtureToTempDir("promotion-typed-project");
    try {
      await pointConfigAt(rootDir, baseURL);
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "create-project", "--args", JSON.stringify({ name: "acme" })],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      const stepRecord = JSON.parse(stdout.text());
      expect(stepRecord.status).toBe("ok");
      expect(stepRecord.result).toEqual({ id: "p-1", name: "acme" });
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("`nuka do` refuses the compat step by name and writes no step record", async () => {
    const rootDir = await copyFixtureToTempDir("promotion-glue-project");
    try {
      await pointConfigAt(rootDir, baseURL);
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["do", "compat: a project {string} exists", "--args", "{}"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain("compat step");
      expect(stderr.text()).toContain("defineStep");
      expect(existsSync(path.join(rootDir, ".nukadoko"))).toBe(false);
    } finally {
      await removeTempDir(rootDir);
    }
  });
});
