import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";

function baseConfig(overrides: Partial<NukadokoConfig> = {}): NukadokoConfig {
  return {
    featuresDir: "features",
    stateDir: ".nukadoko",
    envFiles: [],
    secrets: { public: [] },
    ...overrides,
  };
}

describe("createStepContext / ctx.request()", () => {
  let server: Server;
  let baseURL: string;
  let evidenceDir: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseURL = `http://127.0.0.1:${address.port}`;
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-"));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("logs method/url/status/duration_ms for each request to http.jsonl", async () => {
    const { ctx, dispose } = createStepContext({
      config: baseConfig({ baseURL }),
      evidenceDir,
      env: {},
    });

    const request = await ctx.request();
    const ok = await request.get("/ok");
    expect(ok.status()).toBe(200);
    const missing = await request.get("/missing");
    expect(missing.status()).toBe(404);

    const { evidence } = await dispose("ok");
    expect(evidence.http).toBe("http.jsonl");
    expect(evidence.trace).toBeUndefined();
    expect(evidence.screenshots).toEqual([]);

    const lines = (await readFile(path.join(evidenceDir, "http.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ method: "GET", status: 200 });
    expect(lines[0]?.url).toContain("/ok");
    expect(typeof lines[0]?.duration_ms).toBe("number");
    expect(lines[1]).toMatchObject({ method: "GET", status: 404 });
  });

  it("records fetch()'s method from options.method rather than always GET", async () => {
    // Ideally this would pass a Playwright `Request` object (the case
    // fetch()'s method detection actually needed fixing: it must prefer
    // `request.method()` over defaulting to GET) rather than an options
    // object, but constructing a real `Request` requires driving it through
    // an actual page/route, which would pull chromium into what is
    // otherwise a plain node:http-server test file. Substituting an
    // explicit `options.method` here still exercises the same `methodOf`
    // logic in src/context/http-log.ts (options.method takes priority
    // before any Request-vs-string check), per the task spec's allowance
    // to substitute this case and note it.
    const { ctx, dispose } = createStepContext({
      config: baseConfig({ baseURL }),
      evidenceDir,
      env: {},
    });

    const request = await ctx.request();
    await request.fetch("/ok", { method: "PUT" });

    await dispose("ok");

    const lines = (await readFile(path.join(evidenceDir, "http.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ method: "PUT" });
  });

  it("omits evidence.http when request() was never called", async () => {
    const { dispose } = createStepContext({
      config: baseConfig({ baseURL }),
      evidenceDir,
      env: {},
    });

    const { evidence } = await dispose("ok");
    expect(evidence.http).toBeUndefined();
  });

  it("throws an error naming the baseURL config key when unset", async () => {
    const { ctx } = createStepContext({
      config: baseConfig({ baseURL: undefined }),
      evidenceDir,
      env: {},
    });

    await expect(ctx.request()).rejects.toThrow(/baseURL/);
  });
});
