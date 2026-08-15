import { chromium, firefox, webkit, type Page } from "playwright";
import type { NukadokoConfig } from "../config/schema.js";
import { assertWebmcpAvailable } from "./errors.js";

// Responsibility: the "A" half of this experimental pair, `nuka experimental
// webmcp-tools <url>` (src/cli/webmcp.ts is its thin CLI wiring): read
// whichever WebMCP tools a page has already declared through
// `navigator.modelContext.registerTool`, as a report, never as a source of
// step vocabulary. `nuka steps` never reads this module and this module
// never reads discovery: the two lists stay on separate faces on purpose,
// because folding a page's own declared tools into `nuka steps`' output
// would let a page decide part of this project's own step vocabulary, the
// same mistake this package's design exists to rule out for a generated
// implementation.
//
// This module's own browser launch is deliberately standalone rather than
// going through context/create-context.ts: that module's whole job is
// wiring a launch into step records, tracing, and session storageState for a
// step execution, none of which applies here. This launches, reads, and
// closes, with no step record and no persisted state.
//
// EXPERIMENTAL. See call-tool.ts's own header for the removal condition
// this mark shares with `experimental_callWebmcpTool`: both are marked for
// the same reason, since both call into the same still-evolving browser API.

const BROWSER_ENGINES = { chromium, firefox, webkit } as const;

export interface WebmcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  /**
   * As Chromium 149's `getTools()` hands it back: already a JSON string,
   * not a parsed object (measured; see this file's own tests). Carried
   * through exactly as received rather than `JSON.parse`d and
   * re-serialized: a parse/re-stringify round trip is itself a lossy
   * conversion (duplicate object keys collapse to the last one, a schema
   * author's own key order and formatting are gone), and this field exists
   * for a person to read while hand-writing a step's own `args` schema, not
   * for this package to reshape.
   */
  readonly inputSchema: unknown;
}

/**
 * The subset of Chromium's `navigator.modelContext` this module and
 * call-tool.ts's own evaluate callbacks call. Deliberately not merged into
 * the ambient `Navigator` type via `declare global`: this package's own
 * type declarations reach every project that imports it, and widening
 * every consumer's global `Navigator` type for one experimental surface
 * would be a side effect nobody using this package asked for. Each call
 * site casts locally instead (`navigator as { modelContext?:
 * WebmcpModelContext }`), which only affects that one evaluate callback,
 * running inside the browser, never this package's own published types.
 */
export interface WebmcpModelContext {
  getTools(): Promise<readonly WebmcpToolDescriptor[]>;
  executeTool(tool: WebmcpToolDescriptor, argsJson: string): Promise<string>;
}

/**
 * Reads the tools `page`'s current document has already declared, via a
 * single, one-time `getTools()` call, never a subscription: a tool
 * registered after this call (through the API's own `ontoolchange`) will
 * not appear, and this module never waits for or retries one. Throws
 * `WebmcpNotAvailableError` (errors.ts) when `navigator.modelContext` is
 * absent, rather than returning an empty array indistinguishable from "the
 * page declares nothing".
 *
 * Each raw tool descriptor Chromium hands back also carries `origin` and
 * `window`; neither is carried into `WebmcpToolDescriptor`. `window` is a
 * circular reference back to the page's own global object, which breaks a
 * naive `JSON.stringify` of the raw descriptor (measured directly); `origin`
 * is simply outside the shape this surface set out to expose.
 */
export async function readDeclaredWebmcpTools(page: Page): Promise<WebmcpToolDescriptor[]> {
  await assertWebmcpAvailable(page);
  return page.evaluate(async () => {
    // Non-null: the assertWebmcpAvailable() call above already confirmed
    // modelContext is present on this same page; TypeScript cannot see
    // across that separate evaluate() call, so this asserts what has
    // already been checked rather than re-checking it a second time.
    const modelContext = (navigator as { modelContext?: WebmcpModelContext }).modelContext!;
    const tools = await modelContext.getTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  });
}

export interface ListWebmcpToolsOptions {
  /** Absolute URL to load. Never resolved against `config.baseURL`: doing
   * so would tie this experimental command to whichever environment a
   * project happens to have configured, a decision this narrow surface
   * deliberately leaves out. */
  readonly url: string;
  readonly config: NukadokoConfig;
}

/**
 * Rejects `url` before anything else in `listWebmcpTools` runs: a relative
 * path reaches Playwright's own `page.goto` otherwise, and fails there with
 * an internal Playwright error after the cost of a browser launch has
 * already been paid. Checked here, not in cli/webmcp.ts, so the same rule
 * also applies to a direct call into `listWebmcpTools` that never goes
 * through the CLI at all.
 */
function assertAbsoluteWebmcpUrl(url: string): void {
  try {
    new URL(url);
  } catch {
    throw new Error(
      `The URL must be absolute, including the scheme. ` +
        `Received: ${JSON.stringify(url)}. A relative path is never resolved against ` +
        `config.baseURL: that resolution is left out on purpose, not missing because it is ` +
        `unfinished.`,
    );
  }
}

/**
 * `nuka experimental webmcp-tools <url>`'s own logic: launches the
 * configured browser engine fresh (no session restored, no evidence
 * collected), navigates to `url`, reads whatever tools that page has
 * already declared, and closes the browser again before returning.
 */
export async function listWebmcpTools(
  options: ListWebmcpToolsOptions,
): Promise<WebmcpToolDescriptor[]> {
  const { url, config } = options;
  assertAbsoluteWebmcpUrl(url);
  const engine = BROWSER_ENGINES[config.browserType];
  const browser = await engine.launch(config.browser);
  try {
    const context = await browser.newContext(config.browserContext);
    try {
      const page = await context.newPage();
      await page.goto(url);
      return await readDeclaredWebmcpTools(page);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
