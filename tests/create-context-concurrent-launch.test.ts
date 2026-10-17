import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as playwrightRequest, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { ContextOptionsConflictError, InvalidContextNameError } from "../src/context/context-name.js";
import { createStepContext } from "../src/context/create-context.js";

// Responsibility: concurrent first `ctx.page()` / `ctx.request()` calls (what
// compat glue does with `Promise.all([this.openPage(), this.openPage()])`)
// must share one launch. The browser launcher is stubbed, since a real
// launch is slow and not available everywhere.

const launcher = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("../src/context/browser-evidence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/context/browser-evidence.js")>()),
  launchBrowser: launcher.launch,
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

function stubContext(id: string) {
  const page = { id } as unknown as Page;
  return {
    page,
    collectStorageState: vi.fn(async () => undefined),
    beginStepChunk: vi.fn(async () => {}),
    endStepChunk: vi.fn(async () => {}),
    flushPageHttpLog: vi.fn(async () => {}),
    finalize: vi.fn(async () => []),
  };
}

function stubHandle() {
  const contexts: ReturnType<typeof stubContext>[] = [];
  return {
    contexts,
    browserInfo: { type: "chromium", version: "0" },
    openTracedContext: vi.fn(async (options: { as?: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const context = stubContext(options.as === undefined ? "stub-page" : `stub-page-${options.as}`);
      contexts.push(context);
      return context;
    }),
    close: vi.fn(async () => {}),
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
    expect(handles[0]!.contexts).toHaveLength(1);
    expect(handles[0]!.contexts[0]!.beginStepChunk).toHaveBeenCalledTimes(1);

    await dispose();
    expect(handles[0]!.contexts[0]!.finalize).toHaveBeenCalledTimes(1);
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("opens one context per pageAs name in one browser for concurrent first calls", async () => {
    const handles: ReturnType<typeof stubHandle>[] = [];
    launcher.launch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const handle = stubHandle();
      handles.push(handle);
      return handle;
    });
    const { ctx, dispose, namedContexts } = createStepContext({
      config: baseConfig(),
      evidenceDir,
      env: {},
      stepTitle: "a step",
    });

    const [aki, akiAgain, ben, own] = await Promise.all([
      ctx.pageAs("aki"),
      ctx.pageAs("aki"),
      ctx.pageAs("ben"),
      ctx.page(),
    ]);

    expect(aki).toBe(akiAgain);
    expect(aki).not.toBe(ben);
    expect(aki).not.toBe(own);
    expect(launcher.launch).toHaveBeenCalledTimes(1);
    expect(handles[0]!.contexts).toHaveLength(3);
    expect(namedContexts()).toEqual(["aki", "ben"]);

    await dispose();
    for (const context of handles[0]!.contexts) {
      expect(context.finalize).toHaveBeenCalledTimes(1);
    }
    expect(handles[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("refuses other options for an open name and an invalid name, before anything opens for it", async () => {
    launcher.launch.mockImplementation(async () => stubHandle());
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });

    await expect(ctx.pageAs("Aki")).rejects.toThrow(InvalidContextNameError);
    expect(launcher.launch).not.toHaveBeenCalled();

    const ben = await ctx.pageAs("ben", { javaScriptEnabled: false });
    await expect(ctx.pageAs("ben")).resolves.toBe(ben);
    await expect(ctx.pageAs("ben", { javaScriptEnabled: false })).resolves.toBe(ben);
    await expect(ctx.pageAs("ben", { javaScriptEnabled: true })).rejects.toThrow(ContextOptionsConflictError);
  });

  it("compares a later call against a copy of the first options, with undefined keys read as absent", async () => {
    launcher.launch.mockImplementation(async () => stubHandle());
    const { ctx } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });

    const first: { javaScriptEnabled: boolean; locale?: string } = { javaScriptEnabled: false, locale: undefined };
    const ben = await ctx.pageAs("ben", first);
    await expect(ctx.pageAs("ben", { javaScriptEnabled: false })).resolves.toBe(ben);

    // Mutating the object the first call passed does not move what the
    // context was opened with: the same object now asks for other options.
    first.javaScriptEnabled = true;
    await expect(ctx.pageAs("ben", first)).rejects.toThrow(ContextOptionsConflictError);
    await expect(ctx.pageAs("ben", { javaScriptEnabled: false, viewport: undefined })).resolves.toBe(ben);

    const aki = await ctx.pageAs("aki");
    await expect(ctx.pageAs("aki", { viewport: undefined })).resolves.toBe(aki);
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
