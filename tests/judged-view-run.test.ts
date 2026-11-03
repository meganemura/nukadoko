import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import type { JudgedView } from "../src/record/types.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  latestRunDir,
  latestRunJson,
  removeTempDir,
  stepRecordDir,
  writeUrlProgram,
} from "./helpers/fixtures.js";

// Responsibility: the view of a claim step's judged reading in a real
// browser, end to end: under `nuka run` and `nuka do`, the step record's
// `judged_view` names a screenshot and an ARIA snapshot under `judged/`
// that show the page as the claims read it, run.json names the same files
// from the run directory, the summary links them, the view's own calls
// stay out of the step's `actions`, a claim on an ARIA snapshot leaves the
// view's snapshot out, and `judgedView: false` takes none. The page flips
// its badge from "Saving..." to "Saved" 1.5 seconds after it loads, so the
// view of a Then that read "Saving..." shows "Saving...", while the
// scenario's final.png, taken after a later step waited past the flip, is
// another state.

const PAGE = `<!doctype html><html><head><title>Cart</title></head>
<body><main><h1>Cart</h1><p id="badge">Saving...</p></main>
<script>setTimeout(() => { document.getElementById("badge").textContent = "Saved"; }, 1500);</script>
</body></html>`;

function startServer(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

const STEPS: Readonly<Record<string, string>> = {
  "badge-reads.ts": `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the badge reads {text:string}",
  description: "Open the cart and read its save badge",
  args: z.object({ text: z.string() }),
  async observe({ page, baseURL }) {
    await page.goto(baseURL);
    return { badge: await page.locator("#badge").textContent() };
  },
  poll: false,
  claims: [{ actual: "badge", compare: "equal", expected: "text" }],
});
`,
  "badge-saves.ts": `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the badge has had time to save",
  description: "Wait past the badge's flip",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ page }) {
    await page.waitForTimeout(2000);
    return {};
  },
});
`,
  "cart-tree.ts": `import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the cart shows",
  description: "Judge the cart's accessibility tree against the tree the docstring states",
  args: z.object({ tree: z.string() }),
  async observe({ page, baseURL }) {
    await page.goto(baseURL);
    return { cart: page.getByRole("main") };
  },
  poll: false,
  claims: [{ actual: "cart", compare: "fits-aria-snapshot", expected: "tree" }],
});
`,
};

const FEATURE = `Feature: Cart

  Scenario: The badge says it is saving
    Then the badge reads "Saving..."
    When the badge has had time to save

  Scenario: The cart has a heading
    Then the cart shows
      """
      - heading "Cart"
      """
`;

interface Recorded {
  step_record_id: string;
  judged_view?: JudgedView;
  actions?: { method: string }[];
}

function stepRecord(rootDir: string, id: string): Recorded {
  return JSON.parse(readFileSync(path.join(stepRecordDir(rootDir, id), "record.json"), "utf8")) as Recorded;
}

describe("the view of a claim step's judged reading", () => {
  let server: Server;
  let baseURL: string;
  let rootDir: string;

  beforeEach(async () => {
    ({ server, baseURL } = await startServer());
    rootDir = await copyFixtureToTempDir("run-browser-project");
    await writeUrlProgram(rootDir, baseURL);
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    for (const [file, text] of Object.entries(STEPS)) await writeFile(path.join(rootDir, "features", "steps", file), text);
    await writeFile(path.join(rootDir, "features", "cart.feature"), FEATURE);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempDir(rootDir);
  });

  it("nuka run: records the page as the claims read it, names it from the run directory, links it, and keeps its calls out of actions", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/cart.feature"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode, stderr.text()).toBe(0);

    const run = latestRunJson(rootDir);
    const [badge, saves] = run.scenarios[0].steps as { step_record_id: string; record: string; judged_view?: JudgedView }[];
    const record = stepRecord(rootDir, badge!.step_record_id);
    const view = record.judged_view!;
    expect(view.aria_in_claims).toBeUndefined();
    expect(view.pages).toHaveLength(1);
    const [page] = view.pages;
    expect(page).toMatchObject({ as: null, page: 1, url: `${baseURL}/`, title: "Cart" });
    expect(page!.screenshot!.file).toBe("judged/page.png");
    expect(page!.aria!.file).toBe("judged/page.aria.yml");
    // The screenshot first, then the snapshot, each timed from the reading.
    expect(page!.screenshot!.after_reading_ms).toBeGreaterThanOrEqual(0);
    expect(page!.aria!.after_reading_ms).toBeGreaterThanOrEqual(page!.screenshot!.after_reading_ms);
    const dir = stepRecordDir(rootDir, badge!.step_record_id);
    expect(readFileSync(path.join(dir, "judged", "page.png")).subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(readFileSync(path.join(dir, "judged", "page.aria.yml"), "utf8")).toContain("Saving...");
    // The view's screenshot, title, snapshot, and mask lookups are
    // nukadoko's calls, so the step's actions hold only what observe did.
    expect((record.actions ?? []).map((action) => action.method)).toEqual(["goto", "textContent"]);

    // run.json names the files from the run directory, where summary.md is.
    expect(badge!.judged_view!.pages[0]!.screenshot!.file).toBe(`${badge!.record}/judged/page.png`);
    expect(existsSync(path.join(latestRunDir(rootDir), badge!.judged_view!.pages[0]!.screenshot!.file))).toBe(true);
    // A step that judged nothing takes no view.
    expect(saves!.judged_view).toBeUndefined();
    expect(stepRecord(rootDir, saves!.step_record_id).judged_view).toBeUndefined();

    const summary = readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8");
    expect(summary).toContain("| verdict | criterion | head default | seen |");
    expect(summary).toContain(`| [4](<${badge!.record}/judged/page.png>) |`);
    expect(summary).toMatch(
      new RegExp(`the badge reads "Saving\\.\\.\\."[^\\n]*; seen: \\[page\\]\\(<${badge!.record}/judged/page\\.png>\\)( \\(taken \\d+ ms after the reading\\))?, \\[page ARIA\\]\\(<${badge!.record}/judged/page\\.aria\\.yml>\\)`),
    );

    // A claim on an ARIA snapshot already holds the tree it judged.
    const tree = run.scenarios[1].steps[0] as { step_record_id: string };
    const treeView = stepRecord(rootDir, tree.step_record_id).judged_view!;
    expect(treeView.aria_in_claims).toBe(true);
    expect(treeView.pages[0]!.aria).toBeNull();
    expect(treeView.pages[0]!.screenshot!.file).toBe("judged/page.png");
    expect(existsSync(path.join(stepRecordDir(rootDir, tree.step_record_id), "judged", "page.aria.yml"))).toBe(false);
  });

  it("nuka do: records the view in its own record's directory", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "badge-reads", "--args", JSON.stringify({ text: "Saving..." })], { rootDir, stdout, stderr });
    expect(exitCode, stderr.text()).toBe(0);
    const record = JSON.parse(stdout.text()) as Recorded;
    expect(record.judged_view!.pages[0]!.screenshot!.file).toBe("judged/page.png");
    expect(readFileSync(path.join(stepRecordDir(rootDir, record.step_record_id), "judged", "page.aria.yml"), "utf8")).toContain("Saving...");
  });

  it("judgedView: false takes no view and links nothing", async () => {
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      `import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({ judgedView: false });\n`,
    );
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/cart.feature:3"], { rootDir, stdout: createCaptureSink(), stderr });
    expect(exitCode, stderr.text()).toBe(0);
    const [badge] = latestRunJson(rootDir).scenarios[0].steps as { step_record_id: string }[];
    expect(stepRecord(rootDir, badge!.step_record_id).judged_view).toBeUndefined();
    expect(existsSync(path.join(stepRecordDir(rootDir, badge!.step_record_id), "judged"))).toBe(false);
    expect(readFileSync(path.join(latestRunDir(rootDir), "summary.md"), "utf8")).not.toContain("seen");
  });
});
