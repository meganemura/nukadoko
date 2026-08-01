import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: sessions generalized to per-environment (this task's
// spec, decision 7/scope item 5) — `do --session --env` writing under
// sessions/<env>/ instead of the old hard-coded sessions/default/, `session
// list` enumerating every environment, and `session clear --env` touching
// only the one it names. The request-path round trip itself (cookie survives
// across two `do` calls) is already covered for the default environment by
// session.test.ts; this file only adds the environment dimension.

function sessionsDir(rootDir: string, environment: string): string {
  return path.join(rootDir, ".nukadoko", "sessions", environment);
}

function startTestServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/set-cookie") {
        res.writeHead(200, {
          "set-cookie": "sid=abc123; Path=/",
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ ok: true }));
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

describe("nuka do --session --env: per-environment session files", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startTestServer());
    rootDir = await copyFixtureToTempDir("session-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        `export default defineConfig({ baseURL: "${baseURL}", environments: { staging: {} } });`,
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("writes the session file under sessions/<env>/, not sessions/default/", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "login", "--args", "{}", "--session", "s1", "--env", "staging"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text()).environment).toBe("staging");
    expect(existsSync(path.join(sessionsDir(rootDir, "staging"), "s1.json"))).toBe(true);
    expect(existsSync(path.join(sessionsDir(rootDir, "default"), "s1.json"))).toBe(false);
  });

  it("keeps the same --session name independent across environments", async () => {
    const defaultExit = await runCli(["do", "login", "--args", "{}", "--session", "dup"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(defaultExit).toBe(0);

    const stagingExit = await runCli(
      ["do", "login", "--args", "{}", "--session", "dup", "--env", "staging"],
      { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() },
    );
    expect(stagingExit).toBe(0);

    expect(existsSync(path.join(sessionsDir(rootDir, "default"), "dup.json"))).toBe(true);
    expect(existsSync(path.join(sessionsDir(rootDir, "staging"), "dup.json"))).toBe(true);
  });
});

describe("nuka session list/clear across environments", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-session-env-cli-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeFakeSession(environment: string, name: string): Promise<void> {
    const dir = sessionsDir(rootDir, environment);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ cookies: [], origins: [] }));
  }

  it("lists sessions from every environment, each labeled with its own name", async () => {
    await writeFakeSession("default", "alpha");
    await writeFakeSession("staging", "beta");

    const stdout = createCaptureSink();
    const exitCode = await runCli(["session", "list", "--json"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const list = JSON.parse(stdout.text());
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ environment: "default", name: "alpha" }),
        expect.objectContaining({ environment: "staging", name: "beta" }),
      ]),
    );
    expect(list).toHaveLength(2);
  });

  it("clears sessions only in the named --env, leaving other environments untouched", async () => {
    await writeFakeSession("default", "alpha");
    await writeFakeSession("staging", "alpha");

    const exitCode = await runCli(["session", "clear", "alpha", "--env", "staging"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(existsSync(path.join(sessionsDir(rootDir, "staging"), "alpha.json"))).toBe(false);
    expect(existsSync(path.join(sessionsDir(rootDir, "default"), "alpha.json"))).toBe(true);
  });

  it("defaults --env to \"default\" when omitted, leaving named environments untouched", async () => {
    await writeFakeSession("default", "alpha");
    await writeFakeSession("staging", "alpha");

    const exitCode = await runCli(["session", "clear", "alpha"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(existsSync(path.join(sessionsDir(rootDir, "default"), "alpha.json"))).toBe(false);
    expect(existsSync(path.join(sessionsDir(rootDir, "staging"), "alpha.json"))).toBe(true);
  });

  it("clears every session in one --env when no name is given, leaving other environments untouched", async () => {
    await writeFakeSession("staging", "alpha");
    await writeFakeSession("staging", "beta");
    await writeFakeSession("default", "gamma");

    const exitCode = await runCli(["session", "clear", "--env", "staging"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    expect(existsSync(path.join(sessionsDir(rootDir, "staging"), "alpha.json"))).toBe(false);
    expect(existsSync(path.join(sessionsDir(rootDir, "staging"), "beta.json"))).toBe(false);
    expect(existsSync(path.join(sessionsDir(rootDir, "default"), "gamma.json"))).toBe(true);
  });
});
