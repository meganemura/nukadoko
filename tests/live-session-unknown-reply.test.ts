import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { encodeLine } from "../src/live/protocol.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the reply a live session writes back on its socket, for
// the shapes cli/do.ts and cli/session.ts do not name. A stand-in socket
// is enough: liveLockOwner only asks whether the lock's pid is alive, so
// this process's own pid plus a listening socket reaches sendLiveRequest
// without a daemon. The known replies sit beside the unknown ones so a
// fix that rejects everything still fails here.

function sessionsDir(rootDir: string): string {
  return path.join(rootDir, ".nukadoko", "cache", "sessions", "default");
}

async function listenOnce(reply: unknown): Promise<{ sockPath: string; close: () => Promise<void> }> {
  const sockDir = await mkdtemp(path.join(await realpath("/tmp"), "nk-reply-"));
  const sockPath = path.join(sockDir, "live.sock");
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) {
        socket.end(encodeLine(reply));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  return {
    sockPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(sockDir, { recursive: true, force: true });
    },
  };
}

async function writeLiveLock(rootDir: string, name: string, sockPath: string): Promise<void> {
  const dir = sessionsDir(rootDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${name}.lock`),
    `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), sock: sockPath })}\n`,
  );
}

const unknownReplies = [
  ["an unknown status", { status: "future-status" }, 'status "future-status"'],
  ["an empty object", {}, "no known status"],
  ["null", null, "no known status"],
] as const;

describe("nuka do --session: live session reply", () => {
  it.each(unknownReplies)("fails visibly on %s", async (_label, reply, detail) => {
    const rootDir = await copyFixtureToTempDir("basic-project");
    const standIn = await listenOnce(reply);
    try {
      await writeLiveLock(rootDir, "gale", standIn.sockPath);
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["do", "list-projects", "--args", "{}", "--session", "gale"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain(`Session "gale" is live (pid ${process.pid}) but sent an unrecognized reply`);
      expect(stderr.text()).toContain(detail);
      expect(stderr.text()).not.toContain("TypeError");
      expect(stderr.text()).not.toContain("Cannot read properties");
    } finally {
      await standIn.close();
      await removeTempDir(rootDir);
    }
  });

  it("still prints a record reply and exits 0", async () => {
    const rootDir = await copyFixtureToTempDir("basic-project");
    const record = { status: "ok", session_execution: 4, step: "list-projects" };
    const standIn = await listenOnce({ status: "record", record });
    try {
      await writeLiveLock(rootDir, "gale", standIn.sockPath);
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["do", "list-projects", "--args", "{}", "--session", "gale"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stdout.text()).toContain('"session_execution": 4');
      expect(stderr.text()).toContain(`Session "gale" is live (pid ${process.pid})`);
      expect(stderr.text()).toContain("execution #4");
    } finally {
      await standIn.close();
      await removeTempDir(rootDir);
    }
  });

  it("still reports a rejection as a refusal", async () => {
    const rootDir = await copyFixtureToTempDir("basic-project");
    const standIn = await listenOnce({ status: "rejected", message: "busy" });
    try {
      await writeLiveLock(rootDir, "gale", standIn.sockPath);
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["do", "list-projects", "--args", "{}", "--session", "gale"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain("refused this request: busy");
      expect(stderr.text()).not.toContain("unrecognized reply");
    } finally {
      await standIn.close();
      await removeTempDir(rootDir);
    }
  });
});

describe("nuka session stop: live session reply", () => {
  it.each(unknownReplies)("fails visibly on %s", async (_label, reply, detail) => {
    const rootDir = await copyFixtureToTempDir("session-project");
    const standIn = await listenOnce(reply);
    try {
      await writeLiveLock(rootDir, "alice", standIn.sockPath);
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["session", "stop", "alice"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain(`Failed to stop session "alice" (pid ${process.pid})`);
      expect(stderr.text()).toContain("unrecognized reply");
      expect(stderr.text()).toContain(detail);
      expect(stderr.text()).not.toContain("TypeError");
      expect(stderr.text()).not.toContain("Cannot read properties");
    } finally {
      await standIn.close();
      await removeTempDir(rootDir);
    }
  });

  it("still exits 0 when the session reports it stopped", async () => {
    const rootDir = await copyFixtureToTempDir("session-project");
    const standIn = await listenOnce({ status: "stopped" });
    try {
      await writeLiveLock(rootDir, "alice", standIn.sockPath);
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["session", "stop", "alice"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(0);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toBe("");
    } finally {
      await standIn.close();
      await removeTempDir(rootDir);
    }
  });
});
