import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";

// Responsibility: what a `ctx.request()` call leaves in http.jsonl whatever
// its outcome, against a real local server. A call that throws (a failed
// status check, a refused connection) is still a call that happened and
// `observed` counted it, and `url` has the shape a page entry's has: the
// absolute URL that was requested.

function baseConfig(overrides: Partial<NukadokoConfig> = {}): NukadokoConfig {
  return {
    featuresDir: "features",
    additionalFeatureDirs: [],
    oaths: [],
    stateDir: ".nukadoko",
    envFiles: [],
    parameterTypes: [],
    fixtures: {},
    fixtureTimeout: 60_000,
    secrets: { public: [], redact: [] },
    retention: { runs: 20, adHocDays: 7 },
    stepTimeout: 1_200_000,
    browserType: "chromium",
    worldParameters: {},
    ...overrides,
  };
}

describe("ctx.request() / http.jsonl entry per call outcome", () => {
  let server: Server;
  let baseURL: string;
  let evidenceDir: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === "/boom") {
        res.writeHead(500);
        res.end();
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "/ok" });
        res.end();
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-request-outcome-"));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(evidenceDir, { recursive: true, force: true });
  });

  async function lines(): Promise<Record<string, unknown>[]> {
    return (await readFile(path.join(evidenceDir, "http.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("logs a call that throws on a failed status, with status 0 and an error", async () => {
    const { ctx, dispose, observedCounts } = createStepContext({ config: baseConfig({ baseURL }), evidenceDir, env: {} });
    const request = await ctx.request();

    await expect(request.get("/boom", { failOnStatusCode: true })).rejects.toThrow(/500/);
    await dispose();

    const [line, ...rest] = await lines();
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ method: "GET", url: "/boom", status: 0, via: "request" });
    expect(line?.error).toEqual(expect.stringContaining("500"));
    expect(observedCounts()).toMatchObject({ http_reads: 1 });
  });

  it("logs a refused connection with the declared URL, status 0 and an error", async () => {
    const { ctx, dispose } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const request = await ctx.request();
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const deadURL = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/x`;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    await expect(request.get(deadURL)).rejects.toThrow();
    await dispose();

    const [line] = await lines();
    expect(line).toMatchObject({ method: "GET", url: deadURL, status: 0 });
    expect(typeof line?.error).toBe("string");
    expect(line).not.toHaveProperty("declared_url");
  });

  it("logs the absolute URL with params, and the declared one beside it", async () => {
    const { ctx, dispose } = createStepContext({ config: baseConfig({ baseURL }), evidenceDir, env: {} });
    const request = await ctx.request();

    await request.get("/search", { params: { q: "a b" } });
    await dispose();

    const [line] = await lines();
    expect(line).toMatchObject({
      url: `${baseURL}/search?q=a+b`,
      declared_url: "/search",
      status: 200,
    });
    expect(line).not.toHaveProperty("error");
  });

  it("logs the URL a redirect ended at, and the declared one beside it", async () => {
    const { ctx, dispose } = createStepContext({ config: baseConfig({ baseURL }), evidenceDir, env: {} });
    const request = await ctx.request();

    await request.get("/redirect");
    await dispose();

    const [line] = await lines();
    expect(line).toMatchObject({ url: `${baseURL}/ok`, declared_url: "/redirect", status: 200 });
  });

  it("leaves declared_url out when the declared URL is already the logged one", async () => {
    const { ctx, dispose } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    const request = await ctx.request();

    await request.get(`${baseURL}/ok`);
    await dispose();

    const [line] = await lines();
    expect(line).toMatchObject({ url: `${baseURL}/ok`, status: 200 });
    expect(line).not.toHaveProperty("declared_url");
  });

  it("returns the response and counts the lost line when the append fails", async () => {
    const missing = path.join(evidenceDir, "gone");
    const { ctx, dispose, httpLogFailedSnapshot } = createStepContext({
      config: baseConfig({ baseURL }),
      evidenceDir: missing,
      env: {},
    });
    const request = await ctx.request();

    const response = await request.get("/ok");
    await dispose();

    expect(response.status()).toBe(200);
    expect(httpLogFailedSnapshot()).toBe(1);
  });
});
