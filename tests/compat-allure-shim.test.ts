import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: m2d-allure-shim task spec's own coverage — the allure-js
// runtime shim (src/compat/allure-runtime.ts) and the declared bucket it and
// the World channel (src/compat/world.ts) both write into (src/compat/
// declared.ts), surfaced on the receipt/hook-record's own `declared` field
// (src/receipt/types.ts, src/run/record-types.ts):
//
//   - compat glue calling the allure-js facade directly (the door's own
//     main path — no import switch, `import ... from "allure-js-commons"`
//     unmodified);
//   - the World channel (`this.attach`/`log`/`link`, held-but-unread since
//     m2b-compat-execution) now wired to the same collector;
//   - a Before hook's own declared data landing on `record.hooks[].declared`
//     instead of any step's own receipt;
//   - a *typed* step importing the facade directly, proving collection is
//     kind-independent;
//   - a scenario with no facade/World-channel calls at all getting no
//     `declared` field;
//   - a declared label whose value is a configured secret getting redacted
//     the same way any other receipt string does.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readReceipt(rootDir: string, receiptId: string): Promise<Record<string, unknown>> {
  const receiptPath = path.join(rootDir, ".nukadoko", "receipts", receiptId, "receipt.json");
  return JSON.parse(await readFile(receiptPath, "utf8"));
}

describe("nuka run: allure-js runtime shim and the declared bucket", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("allure-shim-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("a compat step calling the allure facade directly gets declared attachments/labels/links/parameters/logs, and the attachment file exists", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/compat-declared.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const receipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect(receipt.declared).toEqual({
      // ".txt": the fixture's own `attachment("evidence", "...", "text/plain")`
      // declares a contentType but no fileExtension — src/compat/allure-
      // runtime.ts now falls back to declared.ts's own
      // `extensionForMediaType` for exactly this case (M3-C spec item 2;
      // render-check.md section 4's finding about a declared attachment
      // whose content-type has no matching declared file extension).
      attachments: ["evidence.txt"],
      labels: [{ name: "owner", value: "team-nukadoko" }],
      links: [{ url: "https://example.com/ticket/1", name: "ticket" }],
      parameters: [{ name: "mode", value: "smoke" }],
      logs: ["a logged sub-step: passed", "a nested step: passed"],
    });

    const receiptDir = path.join(rootDir, (receipt.evidence as { dir: string }).dir);
    expect(existsSync(path.join(receiptDir, "evidence.txt"))).toBe(true);
    const attachmentContent = await readFile(path.join(receiptDir, "evidence.txt"), "utf8");
    expect(attachmentContent).toBe("hello from compat");
  });

  it("a compat step's World channel (this.attach/log/link) declares into the same bucket", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/world-declared.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const receipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect(receipt.declared).toEqual({
      attachments: ["attachment.txt"],
      links: [{ url: "https://example.com/world-link", name: "world link" }],
      logs: ["a logged world line"],
    });

    const receiptDir = path.join(rootDir, (receipt.evidence as { dir: string }).dir);
    expect(existsSync(path.join(receiptDir, "attachment.txt"))).toBe(true);
  });

  it("a Before hook's own declared data lands on record.hooks[].declared, not the step's own receipt", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/hook-declared.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const beforeHook = record.hooks.find((h: { type: string }) => h.type === "before");
    expect(beforeHook.status).toBe("ok");
    expect(beforeHook.declared).toEqual({
      // ".txt": same `extensionForMediaType` fallback as the compat-declared
      // fixture above (M3-C spec item 2) — this hook's own glue also
      // declares `contentType: "text/plain"` with no `fileExtension`.
      attachments: ["hook-evidence.txt"],
      labels: [{ name: "hook-owner", value: "team-nukadoko" }],
    });

    const receipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect(receipt.declared).toBeUndefined();

    const scenarioDir = path.join(rootDir, record.evidence.dir);
    expect(existsSync(path.join(scenarioDir, "hook-evidence.txt"))).toBe(true);
  });

  it("a typed step importing the allure facade directly still gets declared on its own receipt (kind-independent)", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/typed-declared.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const receipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect(receipt.declared).toEqual({
      labels: [{ name: "typed-owner", value: "team-nukadoko" }],
    });
    // Never present on a typed step's receipt (src/receipt/types.ts).
    expect(receipt.world).toBeUndefined();
  });

  it("a scenario with no facade/World-channel calls at all gets no declared field", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/no-declared.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const receipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect(receipt.declared).toBeUndefined();
    expect(Object.keys(receipt)).not.toContain("declared");
  });

  it("a declared label whose value is a configured secret is redacted, same as any other receipt string", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/secret-declared.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");

    const receipt = await readReceipt(rootDir, record.steps[0].receipt);
    expect(receipt.declared).toEqual({
      labels: [{ name: "token", value: "{{secret.SHIM_SECRET}}" }],
    });

    const receiptPath = path.join(
      rootDir,
      ".nukadoko",
      "receipts",
      record.steps[0].receipt,
      "receipt.json",
    );
    const receiptText = await readFile(receiptPath, "utf8");
    expect(receiptText).toContain("{{secret.SHIM_SECRET}}");
    expect(receiptText).not.toContain("sekrit-declared-456");

    const recordPath = path.join(rootDir, record.evidence.dir, "record.json");
    const recordText = await readFile(recordPath, "utf8");
    expect(recordText).not.toContain("sekrit-declared-456");
  });
});
