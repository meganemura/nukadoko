import { readFile } from "node:fs/promises";
import path from "node:path";
import { JUnitXmlPrinter } from "@cucumber/junit-xml-formatter";
import { parseEnvelope } from "@cucumber/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: run our messages.ndjson through the real, official
// consumer rather than our own
// structural assertions about it. `@cucumber/junit-xml-formatter` drives
// `@cucumber/query` over the envelope stream to resolve every id reference
// (pickle -> testCase -> testCaseStarted -> testStepFinished, and the
// pickleStepId a failed testStepResult's trace is built from); if any of
// those references don't actually resolve, this is where it would show —
// either as a thrown error or as empty/missing content in the XML, not as
// a passing assertion in messages-emitter.test.ts's own hand-rolled checks.
// Reuses run-project (same fixture run-messages.test.ts drives via a temp
// copy) rather than a new fixture: it already has both a passing and a
// failing scenario, which is exactly what's needed here.

function buildJUnitXml(ndjson: string): string {
  let xml = "";
  const printer = new JUnitXmlPrinter({}, (content) => {
    xml += content;
  });
  for (const line of ndjson.trim().split("\n")) {
    printer.update(parseEnvelope(line));
  }
  return xml;
}

async function readMessagesFile(rootDir: string): Promise<string> {
  const output = path.join(rootDir, ".nukadoko", "export", "messages.ndjson");
  return readFile(output, "utf8");
}

describe("messages.ndjson through the real @cucumber/junit-xml-formatter consumer", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("a passing run: the printer never throws, and the XML it writes is well-formed and accurate", async () => {
    const exitCode = await runCli(["run", "features/passing.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);

    const ndjson = await readMessagesFile(rootDir);

    let xml = "";
    expect(() => {
      xml = buildJUnitXml(ndjson);
    }).not.toThrow();

    // passing.feature has exactly one scenario.
    expect(xml).toMatch(/<testsuite\b[^>]*\btests="1"/);
    expect(xml).toMatch(/<testsuite\b[^>]*\bfailures="0"/);
    expect(xml).toContain('name="create and check a thing"');

    const time = Number(/\btime="([\d.]+)"/.exec(xml)?.[1]);
    expect(Number.isFinite(time)).toBe(true);
    expect(time).toBeGreaterThanOrEqual(0);
  });

  it("a failing run: the printer never throws, and the failure carries the failed step's own text and its error message", async () => {
    const exitCode = await runCli(["run", "features/failing.feature"], {
      rootDir,
      stdout: createCaptureSink(),
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(1);

    const ndjson = await readMessagesFile(rootDir);

    let xml = "";
    expect(() => {
      xml = buildJUnitXml(ndjson);
    }).not.toThrow();

    // failing.feature has exactly one scenario, and it fails.
    expect(xml).toMatch(/<testsuite\b[^>]*\btests="1"/);
    const failuresAttr = /<testsuite\b[^>]*\bfailures="(\d+)"/.exec(xml)?.[1];
    expect(Number(failuresAttr)).toBeGreaterThanOrEqual(1);
    expect(xml).toContain("<failure>");

    // The failed step's own text lands via the formatter's own step trace
    // (built by resolving testStep -> pickleStepId -> PickleStep -> Step),
    // and the error message lands via the <failure> CDATA (built from
    // testStepResult's exception/message) -- both inside the same
    // <testcase>. Either going missing/empty here (without the printer
    // throwing) would mean our pickleStepId or testStepResult.message
    // wiring is broken even though nothing raised.
    expect(xml).toContain("the operation fails");
    expect(xml).toContain("operation failed on purpose");

    const time = Number(/\btime="([\d.]+)"/.exec(xml)?.[1]);
    expect(Number.isFinite(time)).toBe(true);
    expect(time).toBeGreaterThanOrEqual(0);
  });
});
