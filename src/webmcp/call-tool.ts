import type { Page } from "playwright";
import { assertWebmcpAvailable } from "./errors.js";
import type { WebmcpModelContext } from "./list-tools.js";

// Responsibility: the "B" half of this experimental pair, a plain function
// a hand-written typed step imports to call one tool a page has already
// declared through `navigator.modelContext.registerTool`. Kept as a plain
// import rather than a member of `StepFixtures` (src/context.ts): the
// boundary rule that file's own header states is that a fixture carries
// only what the executor must inject, and everything this function needs
// from the executor is `page`, which already reaches a step as a fixture
// on its own. `ctx.poll` moved from an import onto the fixture bag once,
// for a reason that does not apply here: a wait that finishes without being
// recorded cannot be told apart, from a step record, from one that returned
// on its first attempt, and those two call for opposite fixes. Nothing this
// function reads or calls has that shape: the step that calls it declares
// its own `args`/`returns` zod schemas, and those are already validated at
// the run boundary regardless of how the value inside them was produced
// (docs/spec.md "Context API"), so a step's own step record already carries
// whatever this call returned, without this module writing anything new.
//
// EXPERIMENTAL, marked by name (`experimental_` first, not last, so it is
// still visible at the point a step author's own autocomplete would offer
// it) rather than by a runtime flag, for the same reason `nuka experimental
// webmcp-tools` (list-tools.ts) is nested one command deeper than every
// other command this package ships: the whole point is that a caller
// cannot reach either half without typing the word.
//
// Why: the WebMCP standard's own documentation
// (https://developer.chrome.com/docs/ai/webmcp) is itself explicit that the
// standard, and this project's own use of it, may not keep working. Fetched
// 2026-08-13, the English page states, verbatim: "While it may be possible
// to run WebMCP tools in headless environments, this API is primarily
// designed for local browser workflows with a human in the loop," and
// separately that the whole standard "is under active discussion and
// subject to change in the future." The same page's Japanese localization
// (?hl=ja, fetched the same day) currently goes further than the English
// text does: translated, "tool calls are processed in JavaScript, so a
// browser tab or webview must be opened to provide a visible interface and
// browser context; this means agents and auxiliary tools that call tools in
// a headless state are not supported." Calling a page's own tool from
// Node, through Playwright, the way this function does, is exactly what
// either wording describes: a non-human, auxiliary caller. That the English
// and Japanese pages disagreed on this point as of the date above (the
// stronger claim present only in the Japanese text) is itself part of why
// this mark exists: a standard whose own documentation is not settled, even
// about itself, is not one to build an unmarked, load-bearing dependency on.
//
// It measurably works against Chromium 149 today, per this module's own
// tests: measured, not guaranteed to keep working.
//
// Remove the `experimental_` prefix only once both of these hold:
//   - the official documentation affirmatively supports invocation by an
//     auxiliary or headless caller
//   - it no longer describes the standard itself as subject to change
//
// A sentence like the Japanese one above simply disappearing is not enough
// on its own to satisfy either point. The discrepancy this comment just
// described (the English and Japanese pages disagreeing about the same
// claim, on the same day) is itself the reason: it shows that a missing
// sentence does not settle which claim is current.
//
// Every call through this function needs an open tab: WebMCP's own
// documented reason is that tool invocation runs in the page's JavaScript.
// A step that calls it therefore always needs `page`, and `needs_browser:
// true` on that step's own `nuka steps` entry already follows from
// destructuring `page` alone, the same as it does for any other step; this
// function computes nothing about it specially.

/**
 * Calls the WebMCP tool named `name`, previously declared on `page` via
 * `navigator.modelContext.registerTool`, with `args`, and returns its
 * parsed result. Throws `WebmcpNotAvailableError` (errors.ts) when
 * `navigator.modelContext` is absent from `page` at all, and a plain
 * `Error` naming `name` when `modelContext` is present but declares no
 * tool by that name: the two are different facts, kept as different
 * errors for the same reason list-tools.ts's `readDeclaredWebmcpTools`
 * keeps them apart.
 *
 * The lookup and the call both happen inside one `page.evaluate`, not two:
 * Chromium rejects `executeTool` given anything but the exact tool object
 * `getTools()` itself just returned (measured: a reconstructed object with
 * the same fields throws "not of type 'RegisteredTool'"), so the object
 * cannot be handed back out to Node and back in again in between.
 *
 * `args` crosses into the page as `JSON.stringify(args)`: Chromium's own
 * `executeTool` takes the arguments pre-serialized (measured), the same
 * wire shape `WebmcpToolDescriptor.inputSchema` already arrives in. The
 * tool's own result comes back the same way, a JSON string, and is parsed
 * here before returning: unlike `inputSchema`, which is left as text for a
 * person to read (list-tools.ts's own doc comment), this value is read by
 * a step's own `returns` schema, which needs structure, not a string that
 * merely contains one.
 */
export async function experimental_callWebmcpTool(
  page: Page,
  name: string,
  args: unknown = {},
): Promise<unknown> {
  await assertWebmcpAvailable(page);
  const resultJson = await page.evaluate(
    async ({ name, argsJson }: { name: string; argsJson: string }) => {
      // Non-null for the same reason as readDeclaredWebmcpTools
      // (list-tools.ts): assertWebmcpAvailable() above already confirmed
      // this on the same page.
      const modelContext = (navigator as { modelContext?: WebmcpModelContext }).modelContext!;
      const tools = await modelContext.getTools();
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        const declared = tools.map((candidate) => candidate.name).join(", ") || "none";
        throw new Error(`no WebMCP tool named "${name}" (declared: ${declared})`);
      }
      return modelContext.executeTool(tool, argsJson);
    },
    { name, argsJson: JSON.stringify(args) },
  );
  try {
    return JSON.parse(resultJson) as unknown;
  } catch {
    throw new Error(
      `WebMCP tool "${name}" returned a value that could not be parsed as JSON: ${resultJson}`,
    );
  }
}
