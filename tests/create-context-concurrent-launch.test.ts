import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as playwrightRequest, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";

// Responsibility: concurrent first `ctx.page()` / `ctx.request()` calls (what
// compat glue does with `Promise.all([this.openPage(), this.openPage()])`)
// must share one launch. The browser launcher is stubbed, since a real
// launch is slow and not available everywhere.

const launcher = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("../src/context/browser-evidence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/context/browser-evidence.js")>()),
  launchBrowserWithTracing: launcher.launch,
}));

function baseConfig(): NukadokoConfig {
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
  };
}

function stubHandle() {
  const page = { id: "stub-page" } as unknown as Page;
  return {
    page,
    browserInfo: { type: "chromium", version: "0" },
    collectStorageState: vi.fn(async () => undefined),
    beginStepChunk: vi.fn(async () => {}),
    endStepChunk: vi.fn(async () => {}),
    flushPageHttpLog: vi.fn(async () => {}),
    finalize: vi.fn(async () => []),
  };
}

describe("createStepContext: concurrent first calls share one launch", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-evidence-"));
    launcher.launch.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("launches one browser for two concurrent ctx.page() calls and closes it on dispose", async () => {
    const handles: ReturnType<typeof stubHandle>[] = [];
    launcher.launch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const handle = stubHandle();
      handles.push(handle);
      return handle;
    });
    const { ctx, dispose } = createStepContext({
      config: baseConfig(),
      evidenceDir,
      env: {},
      stepTitle: "a step",
    });

    const [first, second] = await Promise.all([ctx.page(), ctx.page()]);

    expect(first).toBe(second);
    expect(launcher.launch).toHaveBeenCalledTimes(1);
    expect(handles[0]!.beginStepChunk).toHaveBeenCalledTimes(1);

    await dispose();
    expect(handles[0]!.finalize).toHaveBeenCalledTimes(1);
  });

  it("retries the launch on the next call after a launch failed", async () => {
    launcher.launch.mockRejectedValueOnce(new Error("launch failed"));
    launcher.launch.mockImplementation(async () => stubHandle());
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });

    await expect(ctx.page()).rejects.toThrow("launch failed");
    await expect(ctx.page()).resolves.toMatchObject({ id: "stub-page" });
    expect(launcher.launch).toHaveBeenCalledTimes(2);
  });

  it("opens one request context for two concurrent ctx.request() calls and disposes it once", async () => {
    const raw = {
      storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
      dispose: vi.fn(async () => {}),
    };
    const newContext = vi
      .spyOn(playwrightRequest, "newContext")
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return raw as never;
      });
    const { ctx, dispose } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });

    const [first, second] = await Promise.all([ctx.request(), ctx.request()]);

    expect(first).toBe(second);
    expect(newContext).toHaveBeenCalledTimes(1);

    await dispose();
    expect(raw.dispose).toHaveBeenCalledTimes(1);
  });
});
