import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEvidenceCollector, mergeTruncated } from "../src/context/evidence.js";
import { InvalidEvidenceNameError } from "../src/context/errors.js";

// Responsibility: EvidenceCollector's own contract in isolation —
// attach()'s immediate write, path()'s allocate-without-write,
// collision avoidance shared between the two, name refusal, the 100-entry
// cap + truncated count, and reset() at a step boundary. The step-record-level
// shape (field omission, redaction, Allure attachment, needs_browser) is
// proven end to end, through `nuka do`/`nuka run`, in tests/evidence.test.ts
// — same split as tests/http-omitted.test.ts vs tests/page-network.test.ts.

describe("EvidenceCollector", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-collector-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("attach() writes the body to the evidence directory and records {name, file, at}", async () => {
    const collector = createEvidenceCollector(() => dir);

    await collector.attach("orders.json", '{"ok":true}');

    const written = await readFile(path.join(dir, "orders.json"), "utf8");
    expect(written).toBe('{"ok":true}');

    const snapshot = await collector.snapshot();
    expect(snapshot.attachments).toHaveLength(1);
    expect(snapshot.attachments[0]).toMatchObject({ name: "orders.json", file: "orders.json" });
    expect(Number.isNaN(Date.parse(snapshot.attachments[0]!.at))).toBe(false);
    expect(snapshot.truncatedCount).toBeUndefined();
  });

  it("attach() accepts Uint8Array bodies too", async () => {
    const collector = createEvidenceCollector(() => dir);

    await collector.attach("dump.bin", new Uint8Array([1, 2, 3]));

    const written = await readFile(path.join(dir, "dump.bin"));
    expect([...written]).toEqual([1, 2, 3]);
  });

  it("attaching the same name twice keeps both files, never overwriting the first", async () => {
    const collector = createEvidenceCollector(() => dir);

    await collector.attach("orders.json", "first");
    await collector.attach("orders.json", "second");

    const first = await readFile(path.join(dir, "orders.json"), "utf8");
    expect(first).toBe("first");
    const second = await readFile(path.join(dir, "orders-2.json"), "utf8");
    expect(second).toBe("second");

    const snapshot = await collector.snapshot();
    expect(snapshot.attachments.map((entry) => entry.file).sort()).toEqual(["orders-2.json", "orders.json"]);
    expect(snapshot.attachments.every((entry) => entry.name === "orders.json")).toBe(true);
  });

  it("path() allocates a path without writing anything, and it is omitted from the snapshot until something is actually written there", async () => {
    const collector = createEvidenceCollector(() => dir);

    const allocated = collector.path("dump.csv");
    expect(allocated).toBe(path.join(dir, "dump.csv"));

    const beforeWrite = await collector.snapshot();
    expect(beforeWrite.attachments).toHaveLength(0);

    await writeFile(allocated, "a,b,c");

    const afterWrite = await collector.snapshot();
    expect(afterWrite.attachments).toHaveLength(1);
    expect(afterWrite.attachments[0]).toMatchObject({ name: "dump.csv", file: "dump.csv" });
  });

  it("path() called twice with the same name returns two different paths", () => {
    const collector = createEvidenceCollector(() => dir);

    const first = collector.path("dump.csv");
    const second = collector.path("dump.csv");

    expect(first).not.toBe(second);
    expect(path.basename(first)).toBe("dump.csv");
    expect(path.basename(second)).toBe("dump-2.csv");
  });

  it("a path() allocation and an attach() sharing a name never collide with each other", async () => {
    const collector = createEvidenceCollector(() => dir);

    const allocated = collector.path("report.txt");
    await collector.attach("report.txt", "attached body");

    expect(path.basename(allocated)).toBe("report.txt");
    await writeFile(allocated, "path body");

    const written = await readFile(path.join(dir, "report-2.txt"), "utf8");
    expect(written).toBe("attached body");

    const snapshot = await collector.snapshot();
    expect(snapshot.attachments.map((entry) => entry.file).sort()).toEqual(["report-2.txt", "report.txt"]);
  });

  it.each(["../escape", "a/b", "a\\b", ".", "..", ""])(
    "refuses a name that could escape the evidence directory: %j",
    async (unsafeName) => {
      const collector = createEvidenceCollector(() => dir);

      await expect(collector.attach(unsafeName, "x")).rejects.toBeInstanceOf(InvalidEvidenceNameError);
      expect(() => collector.path(unsafeName)).toThrow(InvalidEvidenceNameError);
    },
  );

  it("never wrote a file for a refused attach() name", async () => {
    const collector = createEvidenceCollector(() => dir);

    await expect(collector.attach("../escape", "x")).rejects.toThrow(InvalidEvidenceNameError);

    const entriesOutside = await readFile(path.join(dir, "..", "escape"), "utf8").catch(() => null);
    expect(entriesOutside).toBeNull();
  });

  // The evidence directory also holds files the harness writes itself
  // (record.json, final.png, trace.zip, http.jsonl). A step name that
  // matches one of those, or differs only by case, would replace that file
  // on a case-insensitive volume. Linux keeps the two cases apart, so the
  // assertion compares the case-folded names rather than the raw paths.
  const harnessFiles = ["record.json", "final.png", "trace.zip", "http.jsonl"] as const;

  it.each(harnessFiles)(
    "refuses to attach or allocate a harness file name, including a different case: %s",
    async (reserved) => {
      const collector = createEvidenceCollector(() => dir);

      for (const name of [reserved, reserved.toUpperCase()]) {
        await expect(collector.attach(name, "nope")).rejects.toMatchObject({
          name: "ReservedEvidenceNameError",
          message: expect.stringContaining(name),
        });
        expect(() => collector.path(name)).toThrowError(
          expect.objectContaining({
            name: "ReservedEvidenceNameError",
            message: expect.stringContaining(name),
          }),
        );
      }

      const written = (await readdir(dir)).map((entry) => entry.toLowerCase());
      expect(written).not.toContain(reserved.toLowerCase());
    },
  );

  it("keeps two names that differ only by case on different paths, and still attaches a normal name", async () => {
    const collector = createEvidenceCollector(() => dir);

    await collector.attach("notes.txt", "kept");
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe("kept");

    await collector.attach("Report.txt", "first");
    await collector.attach("report.txt", "second");
    const upper = collector.path("Dump.CSV");
    const lower = collector.path("dump.csv");

    expect(path.basename(upper).toLowerCase()).not.toBe(path.basename(lower).toLowerCase());

    const snapshot = await collector.snapshot();
    const reports = snapshot.attachments.filter((entry) => entry.name.toLowerCase() === "report.txt");
    expect(reports).toHaveLength(2);
    const foldedFiles = reports.map((entry) => entry.file.toLowerCase());
    expect(new Set(foldedFiles).size).toBe(foldedFiles.length);

    const bodies = await Promise.all(reports.map((entry) => readFile(path.join(dir, entry.file), "utf8")));
    expect(bodies.sort()).toEqual(["first", "second"]);
  });

  it("caps the reported attachments at 100 and reports the true total once the cap is exceeded", async () => {
    const collector = createEvidenceCollector(() => dir);

    for (let i = 0; i < 105; i += 1) {
      await collector.attach(`file-${String(i).padStart(3, "0")}.txt`, String(i));
    }

    const snapshot = await collector.snapshot();
    expect(snapshot.attachments).toHaveLength(100);
    expect(snapshot.truncatedCount).toBe(105);
  });

  it("stays untruncated at exactly 100 attachments", async () => {
    const collector = createEvidenceCollector(() => dir);

    for (let i = 0; i < 100; i += 1) {
      await collector.attach(`file-${String(i).padStart(3, "0")}.txt`, String(i));
    }

    const snapshot = await collector.snapshot();
    expect(snapshot.attachments).toHaveLength(100);
    expect(snapshot.truncatedCount).toBeUndefined();
  });

  it("reset() clears the name registry and every pending record", async () => {
    const collector = createEvidenceCollector(() => dir);

    await collector.attach("orders.json", "first");
    collector.reset();
    await collector.attach("orders.json", "second");

    // The registry was cleared, so the second execution's own first use of
    // this name is unsuffixed again — it lands in the same file (this is a
    // fresh step boundary, not a collision within one).
    const written = await readFile(path.join(dir, "orders.json"), "utf8");
    expect(written).toBe("second");

    const snapshot = await collector.snapshot();
    expect(snapshot.attachments).toHaveLength(1);

    await expect(collector.attach("record.json", "nope")).rejects.toMatchObject({
      name: "ReservedEvidenceNameError",
    });
    expect(() => collector.path("FINAL.PNG")).toThrowError(
      expect.objectContaining({ name: "ReservedEvidenceNameError" }),
    );
  });
});

describe("mergeTruncated", () => {
  it("is undefined when neither source was truncated", () => {
    expect(mergeTruncated(undefined, undefined)).toBeUndefined();
  });

  it("carries only actions when only the trace-actions cap was hit", () => {
    expect(mergeTruncated({ actions: 214 }, undefined)).toEqual({ actions: 214 });
  });

  it("carries only evidence when only the evidence cap was hit", () => {
    expect(mergeTruncated(undefined, 105)).toEqual({ evidence: 105 });
  });

  it("carries both when both caps were hit", () => {
    expect(mergeTruncated({ actions: 214 }, 105)).toEqual({ actions: 214, evidence: 105 });
  });
});
