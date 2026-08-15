import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import type { StepSummary } from "../src/cli/vocabulary.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka steps --json`'s own `needs`/`needs_browser` fields
// end to end — against
// tests/fixtures/run-browser-project, a project already carrying both a
// step that destructures `page` and one that destructures nothing browser-
// related (browser-launch fixtures), which
// is exactly the "true for one, false for the other" pair a test needs to
// cover. Read-only: `nuka steps`
// never executes a step, so the fixture project is read directly rather
// than copied to a temp dir (the same choice tests/check-fixture-structural
// .test.ts makes for the same reason).

async function stepsJson(rootDir: string): Promise<StepSummary[]> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  expect(exitCode).toBe(0);
  // `{ steps, import_failures }`, not a bare array — `import_failures` is
  // exercised by a dedicated test file, unrelated to what this helper's
  // callers check.
  const report = JSON.parse(stdout.text()) as { steps: StepSummary[] };
  return report.steps;
}

describe("nuka steps --json: needs / needs_browser", () => {
  it("is true, with page in needs, for a step that destructures page", async () => {
    const summaries = await stepsJson(fixture("run-browser-project"));
    const touchesBrowser = summaries.find((s) => s.name === "touches-browser-directly");
    expect(touchesBrowser?.needs).toEqual(["page"]);
    expect(touchesBrowser?.needs_browser).toBe(true);
  });

  it("is false, with an empty needs array (not omitted), for a step that destructures neither page nor context", async () => {
    const summaries = await stepsJson(fixture("run-browser-project"));
    const noBrowserTouch = summaries.find((s) => s.name === "no-browser-touch");
    expect(noBrowserTouch?.needs).toEqual([]);
    expect(noBrowserTouch?.needs_browser).toBe(false);
    // The key itself must still be present — an empty array is a fact
    // ("this step needs nothing"), not the same as the field being absent.
    expect(noBrowserTouch).toHaveProperty("needs");
    expect(noBrowserTouch).toHaveProperty("needs_browser");
  });

  it("sorts needs alphabetically, not in source destructuring order", async () => {
    const summaries = await stepsJson(fixture("run-browser-project"));
    const browserLogin = summaries.find((s) => s.name === "browser-login");
    // Source order is `{ page, baseURL }`; alphabetized that is baseURL,
    // page.
    expect(browserLogin?.needs).toEqual(["baseURL", "page"]);
    expect(browserLogin?.needs_browser).toBe(true);
  });

  it("omits needs and needs_browser entirely for a compat entry", async () => {
    const summaries = await stepsJson(fixture("compat-project"));
    const compatEntry = summaries.find((s) => s.kind === "compat");
    expect(compatEntry).toBeDefined();
    expect(compatEntry).not.toHaveProperty("needs");
    expect(compatEntry).not.toHaveProperty("needs_browser");
  });
});

describe("nuka steps (text): needs_browser marker", () => {
  it("marks a browser-needing step with a 'browser' label, and says nothing extra for one that doesn't", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps"], {
      rootDir: fixture("run-browser-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    expect(exitCode).toBe(0);
    const text = stdout.text();

    // Exact-line assertions rather than substring checks: the step names
    // themselves contain the literal text "browser", so a substring check
    // for "browser" would pass on the name alone, never actually pinning
    // down whether the marker word is there.
    const browserHeading = text
      .split("\n")
      .find((line) => line.startsWith("touches-browser-directly "));
    expect(browserHeading).toBe("touches-browser-directly  typed  read-only  browser");

    const noBrowserHeading = text.split("\n").find((line) => line.startsWith("no-browser-touch "));
    expect(noBrowserHeading).toBe("no-browser-touch  typed  read-only");

    // The full `needs` list is never spelled out in the text rendering.
    expect(text).not.toContain('needs":');
    expect(text).not.toMatch(/\bpage,\s*context\b/);
  });
});
