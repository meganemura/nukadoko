import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

// Responsibility: `call`/`parts` end to end (docs/spec.md "Parts") against
// tests/fixtures/parts-project — a real local http server, exercised
// through `nuka do` (no scenario/pickle machinery needed: every step here
// is CLI-only vocabulary), covering: a successful call returning a
// returns-validated result with args/result recorded verbatim on the
// calling step's own step record; a part-calling-a-part nesting under
// `calls[0].calls`; a part's own HTTP call landing on the calling step's
// own `observed` rather than a separate tally; a step that calls no part
// carrying no `calls` key at all; and `call`'s two refusals (an undeclared
// part, and a part called with args that fail its own schema) each failing
// the run loudly with the reason recorded on the step record.
//
// `call`'s third refusal — a `Step` discovery never registered — has no
// natural way to arise through ordinary step-file authoring the way the
// other two do (docs/spec.md "Chaining steps" calls this "almost always ...
// reached through a different `await import()`"); it is covered instead as
// a unit test directly against `createStepContext`, the same way tests/
// validate-from.test.ts already proves an unregistered `Step` for `from`
// without needing a real double-import fixture.
//
// A fourth refusal — a part declared `mutates: true`, called from a
// composite declared `mutates: false`, under a read-only environment — is
// covered here too, through both `nuka run` (features/parts.feature) and
// `nuka do` (calls-mutating-part): the read-only policy already refuses a
// declared-mutating *step* before it ever runs, but only checked the entry
// step's own declaration until `ctx.call` closed the gap a part calling out
// from a `mutates: false` composite would otherwise open. `requests.count`
// (the test server's own request tally) is what proves the part's own
// `run` never actually started — the refusal throwing on its own would not
// distinguish "refused before running" from "ran and the assertion just
// didn't check the network".

function startTestServer(): Promise<{ server: Server; baseURL: string; requests: { count: number } }> {
  const requests = { count: 0 };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      requests.count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}

describe("call / parts", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;
  let requests: { count: number };

  beforeEach(async () => {
    ({ server, baseURL, requests } = await startTestServer());
    rootDir = await copyFixtureToTempDir("parts-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        `export default defineConfig({ baseURL: "${baseURL}", environments: { readonly: { policy: "read-only" } } });`,
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("runs a declared, registered part and returns its returns-validated result", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "project-with-member", "--args", '{"email":"a@example.com"}'],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.result).toEqual({ memberId: "m_a@example.com" });
  });

  it("counts a part's own HTTP call on the calling step's own observed, not a separate tally", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "project-with-member", "--args", '{"email":"a@example.com"}'],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    // invite-member (the only part project-with-member calls) is the one
    // that actually issues the POST; project-with-member's own run() never
    // touches `request` at all.
    expect(stepRecord.observed).toEqual({ http_reads: 0, http_writes: 1 });
  });

  it("records args (as given) and result (validated) on calls[0], with a part-of-a-part nested under calls[0].calls", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "project-with-member", "--args", '{"email":"a@example.com"}'],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.calls).toHaveLength(1);
    const call = stepRecord.calls[0];
    expect(call.step).toBe("invite-member");
    expect(call.args).toEqual({ projectId: "p_1", email: "a@example.com" });
    expect(call.result).toEqual({ memberId: "m_a@example.com" });
    expect(typeof call.started_at).toBe("string");
    expect(typeof call.finished_at).toBe("string");
    expect(call.calls).toHaveLength(1);
    const nested = call.calls[0];
    expect(nested.step).toBe("send-invite");
    // `args` is exactly what invite-member.ts passed — no `cc` key, even
    // though send-invite's own `args` schema defaults one: this is what
    // proves `args` is the raw, unvalidated value, not `argsResult.data`
    // (which would carry the default).
    expect(nested.args).toEqual({ email: "a@example.com" });
    // `result` is returns-validated — `channel` is present with its
    // default even though send-invite's own `run` never set it, which is
    // what proves `result` is `returnsResult.data`, not the raw run()
    // return value.
    expect(nested.result).toEqual({ sent: true, channel: "email" });
  });

  it("has no calls key on a step record for a step that calls no part", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "plain-step", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("ok");
    expect(stepRecord.calls).toBeUndefined();
  });

  it("refuses a call() to a Step the caller never declared in parts, and never runs it", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "calls-undeclared-part", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("failed");
    // Anchored on the referents (the caller's own name, the part's own
    // name, and the `parts` identifier), not the prose around them — the
    // exact wording is PartNotDeclaredError's own concern and free to
    // change without breaking this assertion.
    expect(stepRecord.error.message).toContain('"calls-undeclared-part"');
    expect(stepRecord.error.message).toContain('"no-op-part"');
    expect(stepRecord.error.message).toContain("parts");
    // Never began: call() refuses before no-op-part's own run() ever
    // starts, so nothing is recorded about it at all.
    expect(stepRecord.calls).toBeUndefined();
  });

  it("throws when a part's args fail its own schema, and records the failure under calls[0].error", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["do", "calls-part-with-bad-args", "--args", "{}"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("failed");
    expect(stepRecord.error.message).toContain("args validation failed");
    expect(stepRecord.calls).toHaveLength(1);
    const call = stepRecord.calls[0];
    expect(call.step).toBe("takes-a-number");
    expect(call.args).toEqual({ n: "not a number" });
    expect(call.result).toBeUndefined();
    expect(call.error.kind).toBe("args_invalid");
    expect(call.error.message).toContain("args validation failed");
  });

  it("nuka do: refuses a mutates: true part under a read-only environment, even though the caller declared mutates: false, and never runs the part", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(
      ["do", "calls-mutating-part", "--args", "{}", "--env", "readonly"],
      { rootDir, stdout, stderr: createCaptureSink() },
    );

    expect(exitCode).toBe(1);
    const stepRecord = JSON.parse(stdout.text());
    expect(stepRecord.status).toBe("failed");
    expect(stepRecord.error.message).toContain('"mutating-part"');
    expect(stepRecord.error.message).toContain("read-only");
    expect(stepRecord.calls).toBeUndefined();
    // The part's own run() POSTs when it actually executes — a request
    // count of 0 is what proves the refusal happened before that, not
    // merely that something eventually threw.
    expect(requests.count).toBe(0);
  });

  it("nuka run: refuses a mutates: true part under a read-only environment, even though the caller declared mutates: false, and never runs the part", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/parts.feature", "--env", "readonly"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(stdout.text().trim().split("\n")[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].status).toBe("failed");
    // Unlike the entry-step read-only refusal (a "never began" outcome,
    // `step_record_id: null`): the composite itself is not refused, it
    // starts and runs like any other step — `ctx.call`'s own refusal fires
    // from *inside* that run, the same way `PartNotDeclaredError`/args-
    // invalid already do, so this step record is real.
    const recordId = record.steps[0].step_record_id as string;
    expect(recordId).not.toBeNull();
    const stepRecord = await readStepRecord(rootDir, recordId);
    expect(stepRecord.status).toBe("failed");
    const error = stepRecord.error as { message: string };
    expect(error.message).toContain('"mutating-part"');
    expect(error.message).toContain("read-only");
    // Never began: call() refuses before mutating-part's own run() ever
    // starts, so nothing is recorded about it at all.
    expect(stepRecord.calls).toBeUndefined();
    expect(requests.count).toBe(0);
  });
});
