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
// A successful connection's lifetime belongs to the caller (a
// `nukadoko.config.ts` fixture, `defineFixtures`): setup calls this,
// teardown calls `client.close()`, and a scope of "scenario" or "process"
// picks how often. No config key and no registry live here, see
// docs/spec.md "MCP servers".
//
// A failed handshake is this function's to clean up. It spawned the
// process and then rejected before returning a client, so the caller has
// nothing to close. The client package's handshake catch calls `close()`
// without awaiting it, and that call clears the transport's process slot
// before it signals. A second `close()` therefore returns immediately, and
// the first call waits on timers that do not keep the process alive, so a
// caller that exits on the rejection leaves the child running. The pid is
// recorded when the child starts, and the child is signaled before the
// rejection leaves this function.
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
 * (`client.close()`), when the handshake succeeds. When the handshake
 * fails, this function stops the process it spawned before rejecting, and
 * the error names the command. There is no client to return in that case.
 */
export async function connectMcpServer(
  params: StdioServerParameters,
  clientOptions?: ClientOptions,
): Promise<Client> {
  const transport = new StdioClientTransport(params);
  const client = new Client({ name: "nukadoko", version: readOwnVersion() }, clientOptions);
  const spawnedPid = rememberSpawnedPid(transport);
  try {
    await client.connect(transport);
  } catch (error) {
    try {
      await client.close();
    } catch {
      // Closing can fail because the handshake never finished. The spawned
      // process is what still has to stop. The original error is the one
      // the caller needs.
    }
    const pid = spawnedPid();
    if (pid !== null) {
      await stopSpawnedProcess(pid);
    }
    throw handshakeFailed(params.command, error);
  }
  return client;
}

// `start` is the moment the child exists and `pid` is readable. The
// handshake runs after that, and a failure drops the transport's only
// handle (see this module's header), so the pid has to be copied out
// before `connect` can reject.
function rememberSpawnedPid(transport: StdioClientTransport): () => number | null {
  let pid: number | null = null;
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    pid = transport.pid ?? null;
  };
  return () => pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// `close()` above can return while the child is still running (this
// module's header). SIGKILL is the signal that does not depend on the
// child handling it, and the rejection waits until the pid is gone so a
// caller that exits immediately does not outrun the kill.
async function stopSpawnedProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`MCP server process ${pid} was still running after a failed handshake`);
}

function handshakeFailed(command: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const message = `MCP handshake failed for command ${JSON.stringify(command)}: ${detail}`;
  return error instanceof Error ? new Error(message, { cause: error }) : new Error(message);
}
