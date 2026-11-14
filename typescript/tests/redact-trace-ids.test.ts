import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { readFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installChannelPatches } from "../src/context/channels.js";
import { createObservedCollector } from "../src/context/observed.js";
import { createProgramLogReader } from "../src/context/program-log-slice.js";
import { withProcessRecording } from "../src/context/run-command.js";
import { traceIdIn, traceparentOf } from "../src/context/trace-context.js";
import { openProgramLog } from "../src/program/program-log.js";
import { redact, redactString } from "../src/secrets/redact.js";
import type { SecretEntry, SecretSet } from "../src/secrets/types.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a world's trace ids survive redaction (src/secrets/redact.ts,
// the `keep: "trace-ids"` entry a world adds to its secrets): a short
// secret that occurs inside one never changes the id a line of program.log
// carries, the value http.jsonl names, or the trace id a step record
// holds, and a secret outside them is still redacted.

// The prefix holds the secret below, so every trace id of this world does.
const PREFIX = "4bf91234";
const PIN: SecretEntry = { name: "PIN", value: "1234" };
const KEEP: SecretEntry = { name: "WORLD_TRACE_IDS", value: PREFIX, keep: "trace-ids" };
const TRACE_ID = `${PREFIX}77b34da6a3ce929d0e0e4736`;
const SPAN = "00f067aa0ba91234";

describe("redaction with a world's trace ids", () => {
  const hex = "0123456789abcdef";

  it("changes nothing in text that holds no trace id of the world", () =>
    hegel.test((tc) => {
      const values = tc.draw(gs.arrays(gs.text({ alphabet: "wxyz", minSize: 4, maxSize: 8 }), { minSize: 1, maxSize: 3 }));
      const secrets: SecretSet = values.map((value, index) => ({ name: `S${index}`, value }));
      const pieces = tc.draw(gs.arrays(gs.oneOf(gs.text({ alphabet: "wxyz -", maxSize: 6 }), gs.sampledFrom(values)), { maxSize: 8 }));
      const input = pieces.join("");
      expect(redactString(input, [...secrets, KEEP])).toBe(redactString(input, secrets));
    }));

  it("keeps every trace id of the world as it was, redacts each secret outside them, and is stable", () =>
    hegel.test((tc) => {
      const values = tc.draw(gs.arrays(gs.text({ alphabet: hex, minSize: 4, maxSize: 6 }), { minSize: 1, maxSize: 3 }));
      const secrets: SecretSet = [...values.map((value, index) => ({ name: `S${index}`, value })), KEEP];
      const ids = tc.draw(gs.arrays(gs.text({ alphabet: hex, minSize: 24, maxSize: 24 }), { minSize: 1, maxSize: 3 })).map((rest) => `${PREFIX}${rest}`);
      const pieces = tc.draw(
        gs.arrays(gs.oneOf(gs.text({ alphabet: `${hex} =[]`, maxSize: 6 }), gs.sampledFrom(values), gs.sampledFrom(ids.map((id) => `[${traceparentOf(id, SPAN)}]`))), {
          maxSize: 10,
        }),
      );
      const input = pieces.join("");
      const output = redactString(input, secrets);
      expect(traceIdIn(output, PREFIX)).toBe(traceIdIn(input, PREFIX));
      for (const piece of pieces) if (piece.startsWith("[00-")) expect(output).toContain(piece);
      const outside = output.replace(new RegExp(`(?:00-)?${PREFIX}[0-9a-f]{24}(?:-[0-9a-f]{16}-[0-9a-f]{2})?`, "gi"), "\u0000");
      for (const value of values) expect(outside).not.toContain(value);
      expect(redactString(output, secrets)).toBe(output);
    }));

  it("keeps the trace id a step record holds", () => {
    const record = { observed: { program_log: { trace_id: TRACE_ID, lines: 1 } }, note: "pin 1234" };
    expect(redact(record, [PIN, KEEP])).toEqual({ observed: { program_log: { trace_id: TRACE_ID, lines: 1 } }, note: "pin {{secret.PIN}}" });
    expect(redact(record, [PIN])).toEqual({ observed: { program_log: { trace_id: TRACE_ID.replace("1234", "{{secret.PIN}}"), lines: 1 } }, note: "pin {{secret.PIN}}" });
  });
});

describe("a 4-digit secret inside a trace id", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createEmptyTempDir();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("leaves the id in program.log as it was, so the step's slice still gets the line", async () => {
    const logPath = path.join(dir, "program.log");
    const log = openProgramLog(logPath, [PIN, KEEP]);
    const reader = createProgramLogReader(logPath, PREFIX, [PIN, KEEP]);
    log.note(`[${traceparentOf(TRACE_ID, SPAN)}] GET /account pin=1234`);
    log.close();
    expect(readFileSync(logPath, "utf8")).toBe(`[${traceparentOf(TRACE_ID, SPAN)}] GET /account pin={{secret.PIN}}\n`);
    const slice = await reader.slice(path.join(dir, "record"), { traceId: TRACE_ID, stamped: 1, lastStampAt: Date.now() - 1000 });
    expect(slice.lines).toBe(1);
    expect(readFileSync(path.join(dir, "record", "program-log.txt"), "utf8")).toBe(`[${traceparentOf(TRACE_ID, SPAN)}] GET /account pin={{secret.PIN}}\n`);
  });

  describe("on a request's http.jsonl line", () => {
    let server: http.Server;
    let base: string;
    let received: string | undefined;

    beforeAll(async () => {
      installChannelPatches();
      server = http.createServer((req, res) => {
        received = req.headers.traceparent as string | undefined;
        res.end("ok");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    it("names the traceparent that went out as it was", async () => {
      const observed = createObservedCollector({ outputDir: () => path.join(dir, "record"), secrets: [PIN, KEEP], trace: { prefix: PREFIX, origin: base } });
      await withProcessRecording(observed.openRun([]), async () => (await fetch(`${base}/account`)).text());
      await observed.flush();
      const [line] = readFileSync(path.join(dir, "record", "http.jsonl"), "utf8").trimEnd().split("\n").map((text) => JSON.parse(text) as { traceparent?: string });
      expect(received).toContain(PREFIX);
      expect(line!.traceparent).toBe(received);
    });
  });
});
