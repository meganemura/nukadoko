import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NukadokoConfig } from "../src/config/schema.js";
import { createStepContext } from "../src/context/create-context.js";

// Responsibility: the views `nuka run --step` shows at a pause. Each open
// page of each browser context the ctx launched gets a screenshot and an
// ARIA snapshot in the pause directory, the default context first, and the
// page is left as the views found it, since the next step reads it.

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = await isChromiumAvailable();

function baseConfig(): NukadokoConfig {
  return {
    featuresDir: "features",
    additionalFeatureDirs: [],
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

describe("viewOpenPages", () => {
  let evidenceDir: string;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-pause-views-"));
  });

  afterEach(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
  });

  it("returns no views when the ctx launched no browser", async () => {
    const { viewOpenPages, dispose } = createStepContext({ config: baseConfig(), evidenceDir, env: {} });
    expect(await viewOpenPages(evidenceDir, "pauses/1")).toEqual([]);
    await dispose();
  });

  it.skipIf(!chromiumAvailable)(
    "views every open page, default context first, and leaves a focused field's markup as it was",
    async () => {
      const { ctx, viewOpenPages, dispose } = createStepContext({ config: baseConfig(), evidenceDir, env: {}, stepTitle: "a step" });
      const page = await ctx.page();
      await page.setContent("<title>Cart</title><h1>Cart</h1><label>Coupon <input id=coupon></label>");
      await page.focus("#coupon");
      const second = await page.context().newPage();
      await second.setContent("<title>Help</title><p>help</p>");
      const aki = await ctx.pageAs("aki");
      await aki.setContent("<title>Aki</title><button>Pay</button>");
      // Strings, since the tests compile without the DOM's types.
      const markup = await page.evaluate("document.documentElement.outerHTML");

      const pauseDir = path.join(evidenceDir, "pauses", "2");
      await mkdir(pauseDir, { recursive: true });
      const views = await viewOpenPages(pauseDir, "pauses/2");

      expect(views).toEqual([
        { as: null, page: 1, url: "about:blank", title: "Cart", screenshot: "pauses/2/page.png", aria: "pauses/2/page.aria.yml" },
        { as: null, page: 2, url: "about:blank", title: "Help", screenshot: "pauses/2/page-2.png", aria: "pauses/2/page-2.aria.yml" },
        { as: "aki", page: 1, url: "about:blank", title: "Aki", screenshot: "pauses/2/page.aki.png", aria: "pauses/2/page.aki.aria.yml" },
      ]);
      for (const view of views) {
        expect(existsSync(path.join(evidenceDir, view.screenshot!))).toBe(true);
      }
      expect(await readFile(path.join(pauseDir, "page.aria.yml"), "utf8")).toContain('heading "Cart"');
      expect(await readFile(path.join(pauseDir, "page.aki.aria.yml"), "utf8")).toContain('button "Pay"');
      expect(await page.evaluate("document.documentElement.outerHTML")).toBe(markup);
      expect(await page.evaluate("document.activeElement?.id")).toBe("coupon");
      await dispose();
    },
  );

  // Red text on white, so a pixel of the secret's glyphs is any clearly red
  // one; the mask is black and the page has nothing else red.
  const SECRET = "s3cr3t-token-value-42";
  const secretPage =
    `<p style="color:rgb(255,0,0);font:48px sans-serif">token ${SECRET}</p>` +
    `<input id=key style="color:rgb(255,0,0);font:48px sans-serif;width:900px">` +
    `<iframe style="width:900px;border:0" srcdoc="<p style='color:rgb(255,0,0);font:48px sans-serif'>${SECRET}</p>"></iframe>`;

  async function redPixels(png: Buffer): Promise<number> {
    const browser = await chromium.launch({ headless: true });
    try {
      const reader = await browser.newPage();
      // A string, since the tests compile without the DOM's types.
      return (await reader.evaluate(`(async () => {
        const image = new Image();
        image.src = "data:image/png;base64,${png.toString("base64")}";
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const draw = canvas.getContext("2d");
        draw.drawImage(image, 0, 0);
        const data = draw.getImageData(0, 0, image.width, image.height).data;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) red++;
        return red;
      })()`)) as number;
    } finally {
      await browser.close();
    }
  }

  it.skipIf(!chromiumAvailable)("covers a loaded secret in the screenshot, as text, in a frame, and as a field's value, and leaves the page as it was", async () => {
    const secrets = [{ name: "API_TOKEN", value: SECRET }];
    const { ctx, viewOpenPages, dispose } = createStepContext({ config: baseConfig(), evidenceDir, env: {}, secrets, stepTitle: "a step" });
    const page = await ctx.page();
    await page.setContent(secretPage);
    await page.fill("#key", SECRET);
    const markup = await page.evaluate("document.documentElement.outerHTML");

    const pauseDir = path.join(evidenceDir, "pauses", "1");
    await mkdir(pauseDir, { recursive: true });
    const [view] = await viewOpenPages(pauseDir, "pauses/1");

    expect(await redPixels(await readFile(path.join(evidenceDir, view!.screenshot!)))).toBe(0);
    expect(await redPixels(await page.screenshot({ caret: "initial" }))).toBeGreaterThan(0);
    expect(await page.evaluate("document.documentElement.outerHTML")).toBe(markup);
    expect(await page.inputValue("#key")).toBe(SECRET);
    await dispose();
  });

  it.skipIf(!chromiumAvailable)("covers a loaded secret in the final screenshot too", async () => {
    const secrets = [{ name: "API_TOKEN", value: SECRET }];
    const { ctx, dispose } = createStepContext({ config: baseConfig(), evidenceDir, env: {}, secrets, stepTitle: "a step" });
    const page = await ctx.page();
    await page.setContent(secretPage);
    await page.fill("#key", SECRET);
    const result = await dispose();

    const final = result.evidence.screenshots.find((shot) => shot.file.startsWith("final"));
    expect(final).toBeDefined();
    expect(await redPixels(await readFile(path.join(evidenceDir, final!.file)))).toBe(0);
  });
});
