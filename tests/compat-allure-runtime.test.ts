import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeAttachmentContentMessage } from "allure-js-commons/sdk";
import { NukadokoAllureTestRuntime } from "../src/compat/allure-runtime.js";
import { createDeclaredCollector, setActiveDeclaredCollector } from "../src/compat/declared.js";

// Responsibility: unit coverage for NukadokoAllureTestRuntime's own
// `attachment_content` extension-resolution fallback (M3-C spec item 2).
// tests/compat-allure-shim.test.ts already proves the "text/plain, no
// fileExtension" case end to end through a real `nuka run` fixture; this
// file isolates just the branch that changed (narrower and faster), and adds
// the "media type not in declared.ts's own table" case that fixture doesn't
// exercise (render-check.md section 4 / this task's spec: "表に無い media
// type は今までどおり拡張子なし").

describe("NukadokoAllureTestRuntime: attachment_content extension fallback", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-allure-runtime-"));
  });

  afterEach(() => {
    setActiveDeclaredCollector(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  async function sendAttachment(contentType: string, fileExtension?: string) {
    const collector = createDeclaredCollector();
    collector.beginStep(dir);
    setActiveDeclaredCollector(collector);
    const runtime = new NukadokoAllureTestRuntime();
    const message: RuntimeAttachmentContentMessage = {
      type: "attachment_content",
      data: {
        name: "evidence",
        content: Buffer.from("hello").toString("base64"),
        encoding: "base64",
        contentType,
        ...(fileExtension !== undefined ? { fileExtension } : {}),
      },
    };
    await runtime.sendMessage(message);
    return collector.snapshot();
  }

  it("falls back to declared.ts's own extensionForMediaType when fileExtension is absent", async () => {
    const snapshot = await sendAttachment("text/plain");
    expect(snapshot?.attachments).toEqual(["evidence.txt"]);
  });

  it("keeps no extension for a media type not in declared.ts's own table", async () => {
    const snapshot = await sendAttachment("application/pdf");
    expect(snapshot?.attachments).toEqual(["evidence"]);
  });

  it("uses the explicit fileExtension when given, unaffected by contentType", async () => {
    const snapshot = await sendAttachment("text/plain", "log");
    expect(snapshot?.attachments).toEqual(["evidence.log"]);
  });
});
