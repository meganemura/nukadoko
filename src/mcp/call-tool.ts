import type { CallToolResult, Client } from "@modelcontextprotocol/client";

// Responsibility: the one thing this package adds on top of the client
// package's own `Client.callTool` — turning a failed tool call into a
// thrown error. MCP itself does not: a tool that ran and failed comes back
// as a normal, successful response, `{ isError: true, content: [...] }`,
// not a rejected promise (the spec's own "Error handling" section for
// tools). `Client.callTool` hands that response straight to a caller
// either way, so a step that never reads `isError` would record a failed
// tool call as a passing one — the step record would show a step that ran to
// completion, carrying, unread, the one field that says it did not
// actually succeed. That is exactly the "nothing breaks silently" failure
// this package's own design rules refuse to let through, so this one check
// is added here rather than left to every step author to remember.
//
// This is not a portability wrapper (that is ruled out — see this
// package's own design rules on thin bindings over an official API):
// every other field of the client package's own result is returned exactly
// as `Client.callTool` produced it. The only change from a plain
// pass-through is that one in-band failure becomes a loud one.

export type McpToolCallResult = CallToolResult;

/**
 * A short text summary of `result`'s own `content`, for an error message
 * only — never the step-record-facing value, which stays the client package's
 * own result, untouched. `content` is a list of typed parts (text, image,
 * audio, resource, resource_link); only the `text` ones are readable as
 * prose, so those are joined and everything else is left out of the
 * message (the full `content` array is still on the thrown error's own
 * cause, via `result` below, for a caller that wants the rest).
 */
function describeContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return JSON.stringify(content);
  }
  const texts = content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text);
  return texts.length > 0 ? texts.join("\n") : JSON.stringify(content);
}

/**
 * Calls the MCP tool named `name` on `client` with `args`, and returns the
 * client package's own result, unchanged, once it is confirmed not to be
 * an in-band failure. `args` crosses to `Client.callTool` as its own
 * `arguments` field, the client package's own shape
 * (`Record<string, unknown>`, optional) — no translation, and no
 * `zod`-generated shape stands between a hand-written step's `args` and
 * what the server actually receives.
 *
 * Throws when `result.isError` is `true` (this module's own header): the
 * thrown `Error`'s message carries `result.content`'s own text parts, and
 * `result` itself sits on the thrown error's `cause`, so a caller that
 * needs the rest of the failed response (a non-text part, `structuredContent`)
 * still has it.
 */
export async function callMcpTool(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw new Error(`MCP tool "${name}" returned isError: true: ${describeContent(result.content)}`, {
      cause: result,
    });
  }
  return result;
}
