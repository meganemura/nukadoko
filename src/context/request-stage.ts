import type { BrowserContext, Page } from "playwright";
import { withoutChannelRecording } from "./channels.js";
import type { HttpLogEntry } from "./http-log.js";

// Responsibility: the `showRequests` screen. A request a step sends from
// its own process has no page, so the trace viewer shows a blank screen,
// or no trace at all, for a step that only calls an API. This module draws
// each such request on a page of its own, in a browser context of its own,
// and traces that context, so the trace viewer shows what was sent and
// what came back at the moment it happened. Boundary: it draws the
// http.jsonl line as observed.ts wrote it, already redacted, and adds no
// fact of its own; it never sends a request and never touches a page or a
// context the step can reach.
//
// A page of its own, not an overlay on the step's page
// (`page.screencast.showOverlay`): an overlay needs a page the step opened,
// and the trace viewer's screen shows DOM snapshots, which an overlay is
// not part of. Not a trace of the request context alone either: that
// trace lists the calls beside a blank about:blank screen, and it holds
// every request header unredacted.
//
// Each line is drawn inside a trace group named for the request, so the
// trace's action list reads as the requests, not as the setContent calls
// that draw them.
//
// A drawing that fails costs the screen, never the step: the request
// already happened, and http.jsonl has it. The first failure is reported
// through `onFailure`, so a screen that never appears is not silent.

export interface RequestStage {
  /** Starts a new screen for the boundary `title` names. */
  beginStep(title: string | undefined): void;
  /** Draws one request line. Returns at once; the drawing is queued. */
  show(entry: HttpLogEntry): void;
  /** Finishes the drawing and writes the boundary's chunk to `file`, when
   * the boundary sent a request. */
  endStep(file: string): Promise<void>;
  /** Closes the stage's context; the browser is the caller's. */
  close(): Promise<void>;
}

export function createRequestStage(options: {
  /** A plain browser context in the scenario's browser. */
  readonly openContext: () => Promise<BrowserContext>;
  readonly onFailure: (message: string) => void;
}): RequestStage {
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let title: string | undefined;
  let entries: HttpLogEntry[] = [];
  let chunkOpen = false;
  let failed = false;
  // One queue, so lines are drawn in the order they were written and
  // `endStep` waits for the last one.
  let queue: Promise<void> = Promise.resolve();

  async function stage(): Promise<{ context: BrowserContext; page: Page }> {
    if (context === undefined || page === undefined) {
      context = await options.openContext();
      await context.tracing.start({ snapshots: true, screenshots: true });
      page = await context.newPage();
    }
    if (!chunkOpen) {
      await context.tracing.startChunk({ title: title ?? "requests" });
      chunkOpen = true;
    }
    return { context, page };
  }

  async function draw(entry: HttpLogEntry): Promise<void> {
    const opened = await stage();
    entries.push(entry);
    await opened.context.tracing.group(groupName(entry));
    try {
      await opened.page.setContent(screenOf(title, entries));
    } finally {
      await opened.context.tracing.groupEnd();
    }
  }

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue
      .then(() => withoutChannelRecording(work))
      .catch((error: unknown) => {
        if (failed) return;
        failed = true;
        options.onFailure(firstLine(error));
      });
    return queue;
  };

  return {
    beginStep(next) {
      title = next;
      entries = [];
    },
    show(entry) {
      // A line that arrives after its step ended belongs to that step's
      // http.jsonl, not to the screen of the boundary now running.
      if (entry.after_step_end === true || failed) return;
      void enqueue(() => draw(entry));
    },
    endStep(file) {
      return enqueue(async () => {
        if (!chunkOpen || context === undefined) return;
        chunkOpen = false;
        await context.tracing.stopChunk({ path: file });
      });
    },
    async close() {
      await queue;
      await withoutChannelRecording(async () => context?.close()).catch(() => undefined);
    },
  };
}

function firstLine(error: unknown): string {
  // The first line only: Playwright appends a call log that can name
  // request headers.
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

function groupName(entry: HttpLogEntry): string {
  return `${entry.method} ${shortUrl(entry.url)} → ${entry.status === 0 ? "no response" : entry.status}`;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function bodyOf(body: HttpLogEntry["request_body"]): string | undefined {
  if (body === undefined) return undefined;
  if (body.text === undefined) return body.binary ? "(binary)" : "(not read)";
  const pretty = prettyJson(body.text);
  return body.truncated ? `${pretty}\n… (cut)` : pretty;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The whole screen for one step: every request it sent so far, the
 * newest marked. */
function screenOf(title: string | undefined, entries: readonly HttpLogEntry[]): string {
  const cards = entries.map((entry, index) => {
    const newest = index === entries.length - 1;
    const sent = bodyOf(entry.request_body);
    const received = bodyOf(entry.response_body);
    const failed = entry.status === 0 || entry.status >= 400;
    const status = entry.status === 0 ? escape(entry.error ?? "no response") : String(entry.status);
    return `<section class="${newest ? "newest" : ""}">
<header><b>${escape(entry.method)}</b> ${escape(entry.url)}<span class="${failed ? "bad" : "ok"}">${status} · ${entry.duration_ms} ms</span></header>
<div class="io">${sent === undefined ? "" : `<div><h3>sent</h3><pre>${escape(sent)}</pre></div>`}${
      received === undefined ? "" : `<div><h3>received</h3><pre>${escape(received)}</pre></div>`
    }</div></section>`;
  });
  return `<!doctype html><meta charset="utf-8"><title>${escape(title ?? "requests")}</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:20px;color:#1d1d1f;background:#fff}
.by{color:#888;font-size:12px}h1{font-size:18px;margin:4px 0 16px}
section{border:1px solid #d8d8dc;border-radius:8px;margin-bottom:12px;overflow:hidden}
section.newest{border-color:#3366cc;box-shadow:0 0 0 2px #3366cc33}
header{padding:8px 12px;background:#f5f5f7;word-break:break-all}
header span{float:right;font-weight:600;margin-left:12px}.ok{color:#1a7f37}.bad{color:#c62828}
.io{display:flex;gap:1px;background:#e5e5ea}.io>div{flex:1;background:#fff;min-width:0}
h3{margin:0;padding:6px 12px 0;font-size:11px;color:#888;text-transform:uppercase}
pre{margin:0;padding:4px 12px 10px;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:hidden}
</style>
<div class="by">requests this step sent, as http.jsonl records them</div>
<h1>${escape(title ?? "requests")}</h1>
${cards.join("\n")}`;
}
