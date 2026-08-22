import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendLiveRequest } from "../src/live/client.js";
import { createSessionCore, runSessionDaemon, type SessionCore } from "../src/live/daemon.js";
import type { LiveResponse } from "../src/live/protocol.js";
import { readLockInfo } from "../src/session/lock.js";
import { sessionFilePath, sessionLockPath } from "../src/session/paths.js";
import { fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: everything tests/live-session.test.ts cannot reach,
// because it only ever talks to a daemon over a real socket to a real
// subprocess (that file's own header): src/live/daemon.ts's own
// `createSessionCore` is a request dispatcher independent of both, and this
// file drives it directly. One test at the end still opens a real socket
// through `runSessionDaemon`, in-process rather than as a subprocess, so
// `readOneLine`/`handleConnection`/the socket bind itself are exercised
// too. No test in this file spawns a process; the fixture-copy dance below
// exists only so bare specifiers ("zod", the fixture's own re-export shims)
// resolve.

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

async function rewriteShim(dir: string, fileName: string, target: string): Promise<void> {
  const shimPath = path.join(dir, fileName);
  let relative = path.relative(dir, target).split(path.sep).join("/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  await writeFile(shimPath, `export * from "${relative}";\n`);
}

async function createDaemonProject(fixtureName: string): Promise<string> {
  const base = await realpath("/tmp");
  const dir = await mkdtemp(path.join(base, "nkd-"));
  await cp(fixture(fixtureName), dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);

  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await symlink(path.join(repoRoot, "node_modules", "zod"), path.join(dir, "node_modules", "zod"), "dir");

  await rewriteShim(dir, "nukadoko-shim.ts", path.join(repoRoot, "src", "index.js"));
  if (existsSync(path.join(dir, "nukadoko-compat-shim.ts"))) {
    await rewriteShim(dir, "nukadoko-compat-shim.ts", path.join(repoRoot, "src", "compat", "index.js"));
  }

  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function expectRejected(response: LiveResponse, contains: string): void {
  expect(response.status).toBe("rejected");
  if (response.status !== "rejected") {
    throw new Error("unreachable");
  }
  expect(response.message).toContain(contains);
}

function expectRecord(response: LiveResponse) {
  expect(response.status).toBe("record");
  if (response.status !== "record") {
    throw new Error("unreachable");
  }
  return response.record;
}

describe("createSessionCore: request dispatch", () => {
  let rootDir: string;
  let openCores: SessionCore[];

  beforeEach(async () => {
    rootDir = await createDaemonProject("live-daemon-project");
    openCores = [];
  });

  afterEach(async () => {
    // A core still busy at this point (a test that fired a slow request and
    // never awaited it) would just see its own "stop" refused here, same as
    // any other caller racing a busy session; every busy-path test in this
    // file awaits its own slow request before returning, precisely so this
    // stop actually runs and the idle timer it clears never fires later,
    // against a rootDir this same afterEach is about to remove.
    for (const core of openCores) {
      try {
        await core.dispatchRequest({ kind: "stop" });
      } catch {
        // Best-effort: a core already stopped (an idle-timeout test) or one
        // whose stop failed for its own tested reason needs no further
        // cleanup here either way.
      }
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  /** Builds one session core against this test's own `rootDir`, starts its
   * idle timer (matching `runSessionDaemon`'s own sequencing), and tracks it
   * for `afterEach`'s cleanup. `idleTimeoutMs` defaults long enough that no
   * test in this `describe` block ever races it by accident; the dedicated
   * idle-timeout tests below pass a short one on purpose. */
  async function newCore(
    opts: { name?: string; env?: string | null; idleTimeoutMs?: number } = {},
  ): Promise<{ core: SessionCore; exitCalls: number[] }> {
    const exitCalls: number[] = [];
    const result = await createSessionCore({
      rootDir,
      env: opts.env ?? null,
      name: opts.name ?? `core-${openCores.length}`,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      exit: (code: number) => exitCalls.push(code),
    });
    if (!result.ok) {
      throw new Error("createSessionCore setup failed unexpectedly");
    }
    result.core.start();
    openCores.push(result.core);
    return { core: result.core, exitCalls };
  }

  it("an unknown step is rejected", async () => {
    const { core } = await newCore();
    const response = await core.dispatchRequest({ kind: "do", step: "no-such-step", args: {} });
    expectRejected(response, "Unknown step");
  });

  it("a compat step is rejected: no typed contract to run individually", async () => {
    const { core } = await newCore();
    const response = await core.dispatchRequest({
      kind: "do",
      step: "compat: a legacy step runs",
      args: {},
    });
    expectRejected(response, "is a compat step and has no typed contract");
  });

  it("an args validation failure surfaces as a failed step record", async () => {
    const { core } = await newCore();
    const record = expectRecord(await core.dispatchRequest({ kind: "do", step: "echo", args: {} }));
    expect(record.status).toBe("failed");
    expect(record.status === "failed" && record.error.kind).toBe("args_invalid");
  });

  it("a returns validation failure surfaces as a failed step record", async () => {
    const { core } = await newCore();
    const record = expectRecord(await core.dispatchRequest({ kind: "do", step: "bad-return", args: {} }));
    expect(record.status).toBe("failed");
    expect(record.status === "failed" && record.error.kind).toBe("result_invalid");
  });

  it("a thrown step surfaces as a failed step record", async () => {
    const { core } = await newCore();
    const record = expectRecord(await core.dispatchRequest({ kind: "do", step: "throws", args: {} }));
    expect(record.status).toBe("failed");
    expect(record.status === "failed" && record.error.kind).toBe("step_error");
  });

  it("the ok path returns a passing step record", async () => {
    const { core } = await newCore();
    const record = expectRecord(await core.dispatchRequest({ kind: "do", step: "echo", args: { value: "hi" } }));
    expect(record.status).toBe("ok");
    expect(record.status === "ok" && record.result).toEqual({ value: "hi" });
  });

  // Pairs with the test right below it (tests/args-strict.test.ts's own
  // header: a reject-only test would also pass an implementation that
  // refuses everything) — this session's own `executeDo` used to call
  // `entry.step.args.safeParse` directly, which strips an unrecognized key
  // rather than refusing it, so `nuka do --session <live>` was the one form
  // of `nuka do` that still silently accepted one after strictArgsSchema
  // closed this gap for `nuka do`/`nuka run`/`recordStep`.
  it("rejects an extra key echo's args schema does not declare, naming it in the failed step record", async () => {
    const { core } = await newCore();
    const record = expectRecord(
      await core.dispatchRequest({
        kind: "do",
        step: "echo",
        args: { value: "hi", EXTRA_KEY: "should be rejected" },
      }),
    );
    expect(record.status).toBe("failed");
    expect(record.status === "failed" && record.error.kind).toBe("args_invalid");
    expect(record.status === "failed" && record.error.message).toContain("EXTRA_KEY");
  });

  it("still accepts the same call with only the declared key, and records the schema-validated args", async () => {
    const { core } = await newCore();
    const record = expectRecord(await core.dispatchRequest({ kind: "do", step: "echo", args: { value: "hi" } }));
    expect(record.status).toBe("ok");
    // The same `args` shape `nuka do`/`nuka run`/`recordStep`
    // record on a passing step (tests/args-strict.test.ts): the schema-
    // validated value, not whatever `--use` merging left `parsedArgs`
    // holding.
    expect(record.args).toEqual({ value: "hi" });
  });

  // echo's own args schema has no `.default(...)`, so a raw value and a
  // validated one always read identical there — the test right above this
  // one already proves extra-key rejection, but not which of the two
  // values a passing step record actually carries. `greet-default`'s own
  // args schema (tests/fixtures/live-daemon-project/features/steps/
  // greet-default.ts) fills a default the caller never supplies, which is
  // the one case where the two values provably differ.
  it("records the schema-validated args, including a filled default, on a passing step record", async () => {
    const { core } = await newCore();
    const record = expectRecord(
      await core.dispatchRequest({ kind: "do", step: "greet-default", args: { name: "ada" } }),
    );
    expect(record.status).toBe("ok");
    // `tag` was never given: this is the schema's own default, present
    // only if the record holds the validated value.
    expect(record.args).toEqual({ name: "ada", tag: "guest" });
  });

  it("a read-only environment rejects a step declared mutating", async () => {
    const { core } = await newCore({ env: "readonly" });
    const response = await core.dispatchRequest({ kind: "do", step: "mutating", args: {} });
    expectRejected(response, 'has policy "read-only"');
  });

  it("--use fills a from key from an earlier execution's own step record", async () => {
    const { core } = await newCore();
    const created = expectRecord(
      await core.dispatchRequest({ kind: "do", step: "create-thing", args: { name: "widget" } }),
    );
    expect(created.status).toBe("ok");
    const createdId = created.status === "ok" ? (created.result as { id: string }).id : undefined;

    const used = expectRecord(
      await core.dispatchRequest({
        kind: "do",
        step: "use-thing",
        args: {},
        use: [created.step_record_id],
      }),
    );
    expect(used.status).toBe("ok");
    expect(used.status === "ok" && used.result).toEqual({ id: createdId });
    expect(used.used?.[0]?.step).toBe("create-thing");
  });

  it("does not treat a --use-filled key as extra, but still rejects a genuinely extra key given alongside it", async () => {
    const { core } = await newCore();
    const created = expectRecord(
      await core.dispatchRequest({ kind: "do", step: "create-thing", args: { name: "widget" } }),
    );
    expect(created.status).toBe("ok");

    // use-thing's own args schema is `{ id: string }` (tests/fixtures/
    // live-daemon-project/features/steps/use-thing.ts); `--use` fills `id`,
    // and `BOGUS` is the one key this schema never declares.
    const record = expectRecord(
      await core.dispatchRequest({
        kind: "do",
        step: "use-thing",
        args: { BOGUS: "not a real key" },
        use: [created.step_record_id],
      }),
    );
    expect(record.status).toBe("failed");
    expect(record.status === "failed" && record.error.kind).toBe("args_invalid");
    expect(record.status === "failed" && record.error.message).toContain("BOGUS");
  });

  it("a second do against a busy session is refused, not queued", async () => {
    const { core } = await newCore();
    const slow = core.dispatchRequest({ kind: "do", step: "slow", args: { ms: 200 } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rejected = await core.dispatchRequest({ kind: "do", step: "echo", args: { value: "x" } });
    expectRejected(rejected, "only one execution runs at a time");

    const slowRecord = expectRecord(await slow);
    expect(slowRecord.status).toBe("ok");
  });

  it("a stop against a busy session is refused, not queued", async () => {
    const { core } = await newCore();
    const slow = core.dispatchRequest({ kind: "do", step: "slow", args: { ms: 200 } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rejected = await core.dispatchRequest({ kind: "stop" });
    expectRejected(rejected, "try again once it finishes");

    await slow;
  });

  it("a malformed request line is rejected", async () => {
    const { core } = await newCore();
    const response = await core.dispatchLine("not json");
    expectRejected(response, "malformed request JSON");
  });

  it("stop writes storageState to disk before its own response exists", async () => {
    const name = "stopper";
    const { core } = await newCore({ name });

    const touched = expectRecord(await core.dispatchRequest({ kind: "do", step: "touch-request", args: {} }));
    expect(touched.status).toBe("ok");

    const sessionFile = sessionFilePath(rootDir, "s", "default", name);
    expect(existsSync(sessionFile)).toBe(false);

    const stopped = await core.dispatchRequest({ kind: "stop" });
    expect(stopped.status).toBe("stopped");

    expect(existsSync(sessionFile)).toBe(true);
    const saved: unknown = JSON.parse(await readFile(sessionFile, "utf8"));
    expect(saved).toHaveProperty("cookies");
    expect(saved).toHaveProperty("origins");
  });
});

describe("createSessionCore: idle timeout", () => {
  let rootDir: string;
  let openCores: SessionCore[];

  beforeEach(async () => {
    rootDir = await createDaemonProject("live-daemon-project");
    openCores = [];
  });

  afterEach(async () => {
    for (const core of openCores) {
      try {
        await core.dispatchRequest({ kind: "stop" });
      } catch {
        // Already stopped by its own idle timeout, or busy for a reason the
        // test itself already asserted on.
      }
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  it("fires and ends the process when genuinely idle", async () => {
    const exitCalls: number[] = [];
    const result = await createSessionCore({
      rootDir,
      env: null,
      name: "idle-alone",
      idleTimeoutMs: 150,
      exit: (code: number) => exitCalls.push(code),
    });
    if (!result.ok) {
      throw new Error("createSessionCore setup failed unexpectedly");
    }
    openCores.push(result.core);
    result.core.start();

    await waitFor(() => exitCalls.length > 0, 3000);
    expect(exitCalls).toEqual([0]);
  });

  it("re-arms while busy instead of firing mid-execution, then fires once genuinely idle", async () => {
    const exitCalls: number[] = [];
    const result = await createSessionCore({
      rootDir,
      env: null,
      name: "idle-busy",
      idleTimeoutMs: 150,
      exit: (code: number) => exitCalls.push(code),
    });
    if (!result.ok) {
      throw new Error("createSessionCore setup failed unexpectedly");
    }
    openCores.push(result.core);
    const core = result.core;
    core.start();

    const slow = core.dispatchRequest({ kind: "do", step: "slow", args: { ms: 350 } });
    // Past the naive (busy-blind) 150ms deadline, still inside the slow
    // step's own 350ms: if the idle callback did not check `busy` before
    // tearing this session down, exit would already have been called here.
    await new Promise((resolve) => setTimeout(resolve, 280));
    expect(exitCalls).toEqual([]);

    await slow;
    // Left genuinely idle from here, the session still times out on its
    // own: this behavior re-arms the countdown, it does not disable it.
    await waitFor(() => exitCalls.length > 0, 3000);
    expect(exitCalls).toEqual([0]);
  });
});

describe("createSessionCore: setup failures", () => {
  let rootDir: string | undefined;
  let originalExitCode: string | number | null | undefined;

  beforeEach(() => {
    // createSessionCore sets `process.exitCode` on a setup failure, the
    // same signal daemon-entry.ts's own real process relies on
    // (docs/spec.md: "nuka session start"'s bounded poll turns a dead child
    // into a reported failure). Called in-process here, that assignment
    // would otherwise leak into this test file's own exit code; saving and
    // restoring it keeps the assertion honest without lying about what the
    // code under test actually does.
    originalExitCode = process.exitCode;
  });

  afterEach(async () => {
    process.exitCode = originalExitCode;
    if (rootDir !== undefined) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("a broken fixture definition refuses to come up at all", async () => {
    rootDir = await createDaemonProject("live-daemon-broken-fixture-project");
    const result = await createSessionCore({
      rootDir,
      env: null,
      name: "broken",
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      exit: () => {},
    });
    expect(result.ok).toBe(false);
  });

  it("a malformed session file refuses to come up at all", async () => {
    rootDir = await createDaemonProject("live-daemon-project");
    const sessionFile = sessionFilePath(rootDir, "s", "default", "garbled");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, "not json");

    const result = await createSessionCore({
      rootDir,
      env: null,
      name: "garbled",
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      exit: () => {},
    });
    expect(result.ok).toBe(false);
  });
});

describe("runSessionDaemon: a real unix socket, in-process (no subprocess)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createDaemonProject("live-daemon-project");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("serves do, malformed JSON, and stop over a real socket, exiting only after the stop ack", async () => {
    const exitCalls: number[] = [];
    const name = "socket-core";
    await runSessionDaemon({
      rootDir,
      env: null,
      name,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      exit: (code: number) => exitCalls.push(code),
    });

    // The socket's own path is no longer derivable from `rootDir`/`name` —
    // it lives inside a directory `mkdtemp` picked at random under the OS's
    // own temp dir (live-sock.ts) — so it is read back from the lock this
    // daemon already wrote it into (session/lock.ts's own `sock` field),
    // the same way every other reader in this package now reaches it.
    const lockInfo = await readLockInfo(sessionLockPath(rootDir, "s", "default", name));
    if (lockInfo?.sock === undefined) {
      throw new Error("expected the daemon's own lock to name a live session socket");
    }
    const sockPath = lockInfo.sock;
    const sockStats = await stat(sockPath);
    expect(sockStats.mode & 0o777).toBe(0o600);
    // The directory that holds it keeps the same restricted permissions the
    // socket used to get from sitting inside cache/sessions/<env>/ (0700,
    // set with `mode` on mkdir there) — now set explicitly right after
    // `mkdtemp` itself (daemon.ts's own header), since this directory no
    // longer sits inside anything else nukadoko already restricts.
    const sockDirStats = await stat(path.dirname(sockPath));
    expect(sockDirStats.mode & 0o777).toBe(0o700);

    const doResult = await sendLiveRequest(sockPath, { kind: "do", step: "echo", args: { value: "ok" } });
    if (!doResult.ok || doResult.response.status !== "record") {
      throw new Error(`unexpected do response: ${JSON.stringify(doResult)}`);
    }
    expect(doResult.response.record.status === "ok" && doResult.response.record.result).toEqual({ value: "ok" });

    const malformedLine = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(sockPath);
      let buffer = "";
      socket.on("connect", () => socket.write("not json\n"));
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", reject);
    });
    const malformedResponse: unknown = JSON.parse(malformedLine);
    expect(malformedResponse).toMatchObject({ status: "rejected" });
    expect((malformedResponse as { message: string }).message).toContain("malformed request JSON");

    const stopResult = await sendLiveRequest(sockPath, { kind: "stop" });
    expect(stopResult.ok && stopResult.response.status).toBe("stopped");

    await waitFor(() => exitCalls.length > 0, 5000);
    expect(exitCalls).toEqual([0]);
    expect(existsSync(sockPath)).toBe(false);
    // `performCleanup` removes the whole mkdtemp'd directory, not only the
    // socket file inside it (daemon.ts's own header) — nothing under the
    // OS's own temp dir should survive a clean stop.
    expect(existsSync(path.dirname(sockPath))).toBe(false);
  });
});
