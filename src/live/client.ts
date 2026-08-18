import { createConnection } from "node:net";
import { encodeLine, type LiveRequest, type LiveResponse } from "./protocol.js";

// Responsibility: the caller side of protocol.ts's line-delimited JSON —
// one connection, one request written, one response line read back, then
// the connection closes. Used by cli/do.ts (a `LiveDoRequest`, delegating
// one execution to a live session's own daemon) and cli/session.ts (a
// `LiveStopRequest`). Never used by daemon.ts itself, which is the *server*
// side of this same protocol.
//
// A generous default timeout: a step's own `run` can wait on a real page
// for a long time, and this client has no way to tell "the daemon is still
// legitimately working" from "the daemon is wedged" — the busy-session
// refusal (docs/spec.md "Live sessions": one execution at a time) is what
// actually protects a session, not this timeout. It exists only so a dead
// or unresponsive daemon does not hang its caller forever.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface LiveClientOk {
  readonly ok: true;
  readonly response: LiveResponse;
}

export interface LiveClientError {
  readonly ok: false;
  readonly message: string;
}

export type LiveClientResult = LiveClientOk | LiveClientError;

/**
 * Sends one request to the live session listening at `sockPath` and returns
 * its one response line. `ok: false` covers every way this can fail short
 * of the daemon itself answering — connect refused, the socket vanishing
 * mid-call, a malformed response line, or `timeoutMs` elapsing — never
 * thrown, since every caller here already has its own "how do I report a
 * failure" convention (stderr + exit 1) it applies identically whether the
 * cause was a rejection *or* a transport failure.
 */
export function sendLiveRequest(
  sockPath: string,
  request: LiveRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LiveClientResult> {
  return new Promise((resolve) => {
    const socket = createConnection(sockPath);
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish({ ok: false, message: `timed out waiting for a response after ${timeoutMs}ms` });
    }, timeoutMs);

    function finish(result: LiveClientResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }

    socket.on("connect", () => {
      socket.write(encodeLine(request));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      try {
        const response = JSON.parse(line) as LiveResponse;
        finish({ ok: true, response });
      } catch (error) {
        finish({
          ok: false,
          message: `malformed response from the live session: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    });
    socket.on("error", (error: Error) => {
      finish({ ok: false, message: error.message });
    });
    socket.on("close", () => {
      finish({ ok: false, message: "the live session closed the connection before responding" });
    });
  });
}
