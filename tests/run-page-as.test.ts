import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, latestRunDir, createCaptureSink, removeTempDir, stepRecordDir, stripRunProgressLines } from "./helpers/fixtures.js";

// Responsibility: `pageAs(name)` through a real `nuka run` and a real
// browser. Two people sign in to an app that remembers a person by a cookie.
// Each gets a browser context of their own, so the third step still sees
// aki's own name after ben signed in, and ben's context runs with scripts
// off while aki's runs them. Every context lands in the records the default
// one does: a trace chunk per step, actions, http.jsonl lines, request
// counts, and a final screenshot. The browser and every context are closed
// when the scenario ends.

function startServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const page = (who: string) =>
        `<html><body><p id="who">${who}</p><p id="script">off</p>` +
        `<script>document.getElementById("script").textContent = "on";</script></body></html>`;
      if (url.pathname === "/sign-in") {
        const name = url.searchParams.get("name") ?? "";
        res.writeHead(200, { "set-cookie": `who=${name}; Path=/`, "content-type": "text/html" });
        res.end(page(name));
        return;
      }
      if (url.pathname === "/whoami") {
        const who = /(?:^|; )who=([^;]*)/.exec(req.headers.cookie ?? "")?.[1] ?? "nobody";
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page(who));
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

interface StepRecord {
  readonly status: string;
  readonly result: { readonly who: string; readonly script?: string };
  readonly observed: { readonly http_reads: number };
  readonly evidence: {
    readonly dir: string;
    readonly trace?: string;
    readonly named_traces?: readonly { readonly as: string; readonly file: string }[];
    readonly http?: string;
  };
  readonly actions?: readonly { readonly method: string; readonly url?: string; readonly as?: string }[];
}

async function readStepRecord(rootDir: string, recordId: string): Promise<StepRecord> {
  const recordPath = path.join(stepRecordDir(rootDir, recordId), "record.json");
  return JSON.parse(await readFile(recordPath, "utf8")) as StepRecord;
}

async function httpLines(rootDir: string, record: StepRecord): Promise<{ url: string; as?: string; via: string }[]> {
  const text = await readFile(path.join(rootDir, record.evidence.dir, "http.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { url: string; as?: string; via: string });
}

describe("nuka run: pageAs gives each person a browser context of their own", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startServer());
    rootDir = await copyFixtureToTempDir("run-page-as-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      [
        'import { defineConfig } from "./nukadoko-shim.js";',
        `export default defineConfig({ baseURL: "${baseURL}" });`,
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("keeps two people's cookies and script settings apart, records both, and closes them", async () => {
    const launched: Browser[] = [];
    const realLaunch = chromium.launch.bind(chromium);
    const launchSpy = vi.spyOn(chromium, "launch").mockImplementation(async (options) => {
      const browser = await realLaunch(options);
      launched.push(browser);
      return browser;
    });
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    let exitCode: number;
    try {
      exitCode = await runCli(["run", "--records", "features/people.feature"], { rootDir, stdout, stderr });
    } finally {
      launchSpy.mockRestore();
    }

    expect(stripRunProgressLines(stderr.text())).toBe("");
    expect(exitCode).toBe(0);
    const [scenario] = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(scenario.status).toBe("passed");

    // One browser for both people, closed with the scenario.
    expect(launched).toHaveLength(1);
    expect(launched[0]?.isConnected()).toBe(false);

    const [akiSignsIn, benSignsIn, akiAgain]: StepRecord[] = await Promise.all(
      scenario.steps.map((step: { step_record_id: string }) => readStepRecord(rootDir, step.step_record_id)),
    );

    // Different cookie jars: ben signing in did not replace aki's cookie.
    expect(akiSignsIn!.result.who).toBe("aki");
    expect(benSignsIn!.result.who).toBe("ben");
    expect(akiAgain!.result.who).toBe("aki");
    // Per-context options: scripts ran for aki and not for ben.
    expect(akiSignsIn!.result.script).toBe("on");
    expect(benSignsIn!.result.script).toBe("off");

    // Each step's chunk is its context's own, beside where `trace.zip` goes,
    // and the default context, which no step named, wrote none.
    expect(akiSignsIn!.evidence.trace).toBeUndefined();
    expect(akiSignsIn!.evidence.named_traces).toEqual([{ as: "aki", file: "trace.aki.zip" }]);
    expect(benSignsIn!.evidence.named_traces).toEqual([{ as: "ben", file: "trace.ben.zip" }]);
    expect(akiAgain!.evidence.named_traces).toEqual([{ as: "aki", file: "trace.aki.zip" }]);
    for (const record of [akiSignsIn!, benSignsIn!, akiAgain!]) {
      for (const named of record.evidence.named_traces ?? []) {
        expect(existsSync(path.join(rootDir, record.evidence.dir, named.file))).toBe(true);
      }
    }

    // Actions read out of those chunks carry the context's name.
    const akiGotos = (akiSignsIn!.actions ?? []).filter((action) => action.method === "goto");
    expect(akiGotos.map((action) => [action.as, action.url])).toEqual([["aki", "/sign-in?name=aki"]]);
    const benGotos = (benSignsIn!.actions ?? []).filter((action) => action.method === "goto");
    expect(benGotos.map((action) => action.as)).toEqual(["ben"]);

    // Page traffic is counted and logged, tagged with the context's name.
    expect(akiSignsIn!.observed.http_reads).toBeGreaterThan(0);
    expect(await httpLines(rootDir, akiSignsIn!)).toEqual([
      expect.objectContaining({ url: `${baseURL}/sign-in?name=aki`, via: "page", as: "aki" }),
    ]);
    expect(await httpLines(rootDir, benSignsIn!)).toEqual([
      expect.objectContaining({ url: `${baseURL}/sign-in?name=ben`, via: "page", as: "ben" }),
    ]);

    // One final screenshot per context, each on disk.
    expect(scenario.evidence.screenshots.map((shot: { file: string; as?: string }) => [shot.file, shot.as])).toEqual([
      ["final.aki.png", "aki"],
      ["final.ben.png", "ben"],
    ]);
    for (const shot of scenario.evidence.screenshots as { file: string }[]) {
      expect(existsSync(path.join(latestRunDir(rootDir), scenario.evidence.dir, shot.file))).toBe(true);
    }
  });
});
