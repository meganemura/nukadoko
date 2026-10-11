import { createConnection } from "node:net";
import { encodeLine, parseLiveResponse, type LiveRequest, type LiveResponse } from "./protocol.js";

export type { LiveRecordResponse, LiveRejectedResponse, LiveResponse, LiveStoppedResponse } from "./protocol.js";

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
  /** `"reply"`: a JSON value arrived and it is not a known live-session
   * reply. `"transport"`: no such value arrived (connect, timeout, a line
   * that is not JSON, the socket closing first). Callers word these
   * differently, because "connecting failed" is false once a reply has
   * arrived. */
  readonly kind: "transport" | "reply";
  readonly message: string;
}

export type LiveClientResult = LiveClientOk | LiveClientError;

/**
 * Sends one request to the live session listening at `sockPath` and returns
 * its one response line. `ok: false` is a failure to obtain a known reply:
 * connect refused, the socket vanishing mid-call, a line that is not JSON,
 * a JSON value outside the reply union, or `timeoutMs` elapsing. Nothing
 * here is thrown. Callers already report that failure as stderr and exit 1.
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
      finish({
        ok: false,
        kind: "transport",
        message: `timed out waiting for a response after ${timeoutMs}ms`,
      });
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
        const parsed = parseLiveResponse(JSON.parse(line));
        if (!parsed.ok) {
          finish({ ok: false, kind: "reply", message: parsed.message });
          return;
        }
        finish({ ok: true, response: parsed.response });
      } catch (error) {
        finish({
          ok: false,
          kind: "transport",
          message: `malformed response from the live session: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    });
    socket.on("error", (error: Error) => {
      finish({ ok: false, kind: "transport", message: error.message });
    });
    socket.on("close", () => {
      finish({
        ok: false,
        kind: "transport",
        message: "the live session closed the connection before responding",
      });
    });
  });
}
