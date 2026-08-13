import { Client, type ClientOptions } from "@modelcontextprotocol/client";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { readOwnVersion } from "../version.js";

// Responsibility: open a connection to one MCP server over stdio and hand
// back @modelcontextprotocol/client's own, already-connected `Client`,
// nothing this package built. `browser`/`browserContext`
// (src/config/schema.ts) already made the same call for Playwright's own
// `LaunchOptions`: this module takes the client package's own
// `StdioServerParameters` and, optionally, its own `ClientOptions` as its
// two arguments, unmodified, rather than a shape this package invented
// that would need to be kept in sync with every field the client package
// adds or renames later.
//
// A server's process lifetime is not this module's concern. The caller (a
// `nukadoko.config.ts` fixture, `defineFixtures`) owns that already: setup
// calls this, teardown calls `client.close()`, and a scope of "scenario" or
// "process" picks how often. No config key, no registry, and no lifetime
// tracking live here, see docs/spec.md "MCP servers".
//
// `Client` negotiates the MCP protocol era (which handshake it runs, and
// whether it carries version and capabilities per request) through its own
// `versionNegotiation` option, part of `ClientOptions`. A caller who leaves
// `clientOptions` out gets the client package's own default: the plain
// 2025 connect sequence, no probe, no new headers. Passing
// `{ versionNegotiation: { mode: 'auto' } }` adds a `server/discover` probe
// first, with a conservative fallback to that same 2025 sequence when the
// server does not answer as modern; on stdio the probe runs on one extra
// short-lived sibling process per connect, spawned from the same
// `StdioServerParameters`, so a fixture that opts into `'auto'` pays for
// one extra spawn every time its own setup calls this function. A pinned
// mode (`{ mode: { pin: '<version>' } }`) skips that fallback and fails
// loudly instead when the server does not offer the exact pinned revision.
// `connectMcpServer` never reads `clientOptions` itself: it passes whatever
// a caller gives straight to `Client`'s own constructor, the same reason it
// already passes `params` straight to `StdioClientTransport` without
// inspecting it.

/**
 * Spawns `params.command` and connects to it as an MCP server over stdio,
 * completing whichever handshake `Client.connect` runs for the negotiated
 * protocol era (this module's own header) before returning. Returns the
 * client package's own `Client`, connected, not wrapped: a caller reaches
 * every method the client package exposes, including ones this package
 * never anticipated, the same "thin over official APIs" choice
 * `ctx.page()`/`ctx.request()` already make for Playwright.
 *
 * `clientOptions`, when given, passes straight through to `Client`'s own
 * constructor as its second argument, most usefully its own
 * `versionNegotiation` field (this module's own header covers what that
 * changes about the handshake and what it costs). Left out, `Client` is
 * constructed with none of its own optional fields set.
 *
 * stdio only: a server reachable over HTTP or SSE instead needs the client
 * package's own transport for that, used directly. This function does not
 * choose a transport for a caller; it commits to the one nukadoko itself
 * has a reason to open (a server started as a subprocess, the same way a
 * fixture already starts and stops anything else it owns).
 *
 * The caller closes what this opens, from its own fixture's teardown
 * (`client.close()`). This function has no matching lifetime of its own to
 * manage.
 */
export async function connectMcpServer(
  params: StdioServerParameters,
  clientOptions?: ClientOptions,
): Promise<Client> {
  const transport = new StdioClientTransport(params);
  const client = new Client({ name: "nukadoko", version: readOwnVersion() }, clientOptions);
  await client.connect(transport);
  return client;
}
