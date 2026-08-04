import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectTraceEvidence,
  createTraceVersionWarner,
  parseTraceActions,
} from "../src/context/trace-actions.js";
import { createCaptureSink } from "./helpers/fixtures.js";

// Responsibility: src/context/trace-actions.ts's own parsing/zip-reading
// logic, in isolation from a real Playwright browser (browser-evidence.test.ts
// and run-browser.test.ts cover the real-browser path; a hand-built trace.zip
// is the only practical way to exercise the version-mismatch and truncation
// branches, both of which depend on shapes a live browser will not produce on
// demand). Fixture data reuses the exact `before`/`after`/header shapes this
// task's spec already measured ("前提"), not re-derived here.
//
// `buildSingleEntryZip` is a minimal, from-scratch zip writer — `node:zlib`
// only, matching the reader's own dependency budget — that never computes a
// real CRC32 (written as `0`): `readZipEntry`/`readLocalFileEntry` never
// check it, so a fixture only needs to be structurally valid, not a byte-
// perfect zip a general-purpose tool would also accept.

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function buildSingleEntryZip(entryName: string, content: string, method: 0 | 8 = 8): Buffer {
  const nameBuf = Buffer.from(entryName, "utf8");
  const rawData = Buffer.from(content, "utf8");
  const data = method === 8 ? deflateRawSync(rawData) : rawData;

  const localHeader = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(rawData.length),
    u16(nameBuf.length),
    u16(0),
    nameBuf,
  ]);
  const localEntry = Buffer.concat([localHeader, data]);

  const centralHeader = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(rawData.length),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    nameBuf,
  ]);

  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(centralHeader.length),
    u32(localEntry.length),
    u16(0),
  ]);

  return Buffer.concat([localEntry, centralHeader, eocd]);
}

const WALL_TIME = 1700000000000;
const MONOTONIC_TIME = 100;

function headerLine(version: number): string {
  return JSON.stringify({
    version,
    type: "context-options",
    wallTime: WALL_TIME,
    monotonicTime: MONOTONIC_TIME,
    title: "Given the page is open",
  });
}

// The exact `expect` example this task's spec measured ("前提") — reused
// verbatim rather than re-derived, per the spec's own instruction not to
// re-verify it.
const EXPECT_BEFORE = {
  type: "before",
  callId: "call@10",
  class: "Frame",
  method: "expect",
  params: { selector: "#late", expression: "to.be.visible", isNot: false, timeout: 5000 },
  startTime: 562.796,
};
const EXPECT_AFTER = { type: "after", callId: "call@10", endTime: 1375.991 };

describe("parseTraceActions", () => {
  it("turns a before/after expect pair into one action with ms/at/outcome", () => {
    const traceTrace = [headerLine(8), JSON.stringify(EXPECT_BEFORE), JSON.stringify(EXPECT_AFTER)].join(
      "\n",
    );
    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.actions).toEqual([
      {
        method: "expect",
        expression: "to.be.visible",
        selector: "#late",
        is_not: false,
        timeout_ms: 5000,
        // 1375.991 - 562.796 = 813.195, rounded to the nearest ms.
        ms: 813,
        outcome: "passed",
        at: new Date(WALL_TIME + (562.796 - MONOTONIC_TIME)).toISOString(),
      },
    ]);
  });

  it("marks outcome failed when the after entry carries an error", () => {
    const traceTrace = [
      headerLine(8),
      JSON.stringify(EXPECT_BEFORE),
      JSON.stringify({ ...EXPECT_AFTER, error: { message: "Timeout 5000ms exceeded" } }),
    ].join("\n");
    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.actions[0]?.outcome).toBe("failed");
  });

  it("drops every before.params key outside the allowlist", () => {
    const before = {
      type: "before",
      callId: "call@11",
      class: "Frame",
      method: "setContent",
      params: {
        selector: "#kept",
        expression: "kept-too",
        url: "http://example.test/kept",
        isNot: true,
        timeout: 1000,
        html: "<html>this must never reach a receipt</html>",
        someOtherField: "also dropped",
      },
      startTime: 10,
    };
    const after = { type: "after", callId: "call@11", endTime: 20 };
    const traceTrace = [headerLine(8), JSON.stringify(before), JSON.stringify(after)].join("\n");
    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.actions).toEqual([
      {
        method: "setContent",
        selector: "#kept",
        expression: "kept-too",
        url: "http://example.test/kept",
        is_not: true,
        timeout_ms: 1000,
        ms: 10,
        outcome: "passed",
        at: new Date(WALL_TIME + (10 - MONOTONIC_TIME)).toISOString(),
      },
    ]);
    const serialized = JSON.stringify(result.actions);
    expect(serialized).not.toContain("html");
    expect(serialized).not.toContain("someOtherField");
    expect(serialized).not.toContain("this must never reach a receipt");
  });

  it("caps at 100 actions and reports the true total on truncatedCount", () => {
    const lines = [headerLine(8)];
    const total = 105;
    for (let i = 0; i < total; i++) {
      lines.push(
        JSON.stringify({
          type: "before",
          callId: `call@${i}`,
          class: "Frame",
          method: "click",
          params: { selector: `#el-${i}` },
          startTime: i,
        }),
      );
      lines.push(JSON.stringify({ type: "after", callId: `call@${i}`, endTime: i + 1 }));
    }
    const result = parseTraceActions(Buffer.from(lines.join("\n"), "utf8"));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.actions).toHaveLength(100);
    expect(result.truncatedCount).toBe(total);
  });

  it("omits truncatedCount when the cap was never hit", () => {
    const traceTrace = [headerLine(8), JSON.stringify(EXPECT_BEFORE), JSON.stringify(EXPECT_AFTER)].join(
      "\n",
    );
    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.truncatedCount).toBeUndefined();
  });

  it("reports an unknown trace format version instead of guessing", () => {
    const traceTrace = [headerLine(999), JSON.stringify(EXPECT_BEFORE), JSON.stringify(EXPECT_AFTER)].join(
      "\n",
    );
    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));
    expect(result).toEqual({ kind: "unknown-version", version: 999 });
  });

  it("is unreadable, never a guess, when there is no header at all", () => {
    const traceTrace = [JSON.stringify(EXPECT_BEFORE), JSON.stringify(EXPECT_AFTER)].join("\n");
    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));
    expect(result).toEqual({ kind: "unreadable" });
  });

  it("skips one malformed JSON line without losing the rest", () => {
    const traceTrace = [
      headerLine(8),
      "{not json",
      JSON.stringify(EXPECT_BEFORE),
      JSON.stringify(EXPECT_AFTER),
    ].join("\n");
    const result = parseTraceActions(Buffer.from(traceTrace, "utf8"));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.actions).toHaveLength(1);
  });
});

describe("createTraceVersionWarner", () => {
  it("writes the exact warning text, and only once, no matter how many versions it sees", () => {
    const stderr = createCaptureSink();
    const warn = createTraceVersionWarner(stderr);
    warn(999);
    warn(999);
    warn(12);
    expect(stderr.text()).toBe(
      "warning: trace format version 999 is not readable by this build; step actions were not recorded\n",
    );
  });
});

describe("collectTraceEvidence", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-trace-actions-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns nothing at all when trace.zip does not exist", async () => {
    const result = await collectTraceEvidence(dir, () => {
      throw new Error("must not be called");
    });
    expect(result).toEqual({});
  });

  it("reads trace.trace out of a real zip and returns trace + actions + truncated", async () => {
    const traceTrace = [headerLine(8), JSON.stringify(EXPECT_BEFORE), JSON.stringify(EXPECT_AFTER)].join(
      "\n",
    );
    await writeFile(path.join(dir, "trace.zip"), buildSingleEntryZip("trace.trace", traceTrace));
    const result = await collectTraceEvidence(dir, () => {
      throw new Error("must not be called");
    });
    expect(result.trace).toBe("trace.zip");
    expect(result.actions).toHaveLength(1);
    expect(result.actions?.[0]?.method).toBe("expect");
    expect(result.truncated).toBeUndefined();
  });

  it("returns only trace when trace.trace is missing from the zip", async () => {
    await writeFile(path.join(dir, "trace.zip"), buildSingleEntryZip("trace.network", "{}"));
    const result = await collectTraceEvidence(dir, () => {
      throw new Error("must not be called");
    });
    expect(result).toEqual({ trace: "trace.zip" });
  });

  it("returns only trace, never throws, when trace.zip is not actually a zip", async () => {
    await writeFile(path.join(dir, "trace.zip"), Buffer.from("not a zip file at all"));
    const result = await collectTraceEvidence(dir, () => {
      throw new Error("must not be called");
    });
    expect(result).toEqual({ trace: "trace.zip" });
  });

  it("calls onUnknownVersion and omits actions when the trace's own version is unreadable", async () => {
    const traceTrace = [headerLine(999), JSON.stringify(EXPECT_BEFORE), JSON.stringify(EXPECT_AFTER)].join(
      "\n",
    );
    await writeFile(path.join(dir, "trace.zip"), buildSingleEntryZip("trace.trace", traceTrace));
    const seenVersions: number[] = [];
    const result = await collectTraceEvidence(dir, (version) => seenVersions.push(version));
    expect(result).toEqual({ trace: "trace.zip" });
    expect(seenVersions).toEqual([999]);
  });

  it("also works against a stored (uncompressed) zip entry", async () => {
    const traceTrace = [headerLine(8), JSON.stringify(EXPECT_BEFORE), JSON.stringify(EXPECT_AFTER)].join(
      "\n",
    );
    await writeFile(path.join(dir, "trace.zip"), buildSingleEntryZip("trace.trace", traceTrace, 0));
    const result = await collectTraceEvidence(dir, () => {
      throw new Error("must not be called");
    });
    expect(result.actions).toHaveLength(1);
  });
});
