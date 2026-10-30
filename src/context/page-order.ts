import type { BrowserContext, Page, Request as PlaywrightRequest } from "playwright";
import type { EventsProducerRecord, PageRequestRecord } from "../record/types.js";
import { stampsUrl } from "./trace-context.js";

// Responsibility: which requests to the world each page of a browser
// context had finished receiving the response of, and which were still in
// flight, around one reading of a claim step (docs/spec.md "What the pages
// had received"). Boundary: the order nukadoko received Playwright's
// events in, per page; which step a request belongs to and the record's
// shape are create-context.ts's and the run layer's.
//
// This is a measurement of order, never of what a page drew: a reading
// that came after a response finished does not show that the page drew
// from it, and nothing here says whether it did. A response that finished
// "before the reading" is one whose `requestfinished` event this process
// had received when the reading began. Measured on Chromium with
// Playwright 1.61.1: of 300 readings that read text a page swapped in from
// a response, none came before its `requestfinished` event.
//
// Playwright's context events, not the DevTools session browser-trace.ts
// stamps with: they come on every engine, and asking Chromium for its
// Network events on a second session cost a page that loads 200 images
// and makes 50 fetches 414 ms against 457 ms (the median of six). A
// request's `traceparent` is read off the request once it ended:
// `headerValue` for a request still waiting on its response did not
// resolve within a second for 4 of 10 measured, so a request in flight
// when the record is written has no trace id.
//
// Only a document, a `fetch`, and an XMLHttpRequest count, the kinds
// browser-trace.ts stamps. An EventSource is left out: its response is a
// stream that stays open, so it would be in flight on every reading
// (measured: Playwright fires `requestfinished` for one only when the
// server ends the stream). A WebSocket sends no HTTP request to count.

/** The state of one page's requests: those still open, in the order
 * sent, and the latest whose response finished. Pure. */
export interface PageOrder<R> {
  /** The page sent `request`. */
  sent(request: R): void;
  /** The page finished receiving the response to `request`. A request
   * this order never saw sent is ignored. */
  finished(request: R): void;
  /** `request` ended without a response. */
  failed(request: R): void;
  /** Opens a reading: what had finished before it, and what was in flight
   * during it. */
  begin(): ReadingWindow<R>;
}

/** What one page had received around one reading. */
export interface PageAtReading<R> {
  /** The latest request whose response finished before the reading
   * began; `null` when none had. */
  readonly last: R | null;
  /** Every request open at some moment of the reading: open when it
   * began, or sent before it ended, in the order sent. */
  readonly inFlight: readonly R[];
}

export interface ReadingWindow<R> {
  /** Closes the reading. Only the first call counts. */
  end(): PageAtReading<R>;
}

export function createPageOrder<R>(): PageOrder<R> {
  const open = new Set<R>();
  let last: R | null = null;
  // The readings open now, each with the requests sent since it began.
  const windows = new Set<R[]>();
  return {
    sent(request) {
      open.add(request);
      for (const sentDuring of windows) sentDuring.push(request);
    },
    finished(request) {
      if (!open.delete(request)) return;
      last = request;
    },
    failed(request) {
      open.delete(request);
    },
    begin() {
      const lastBefore = last;
      const openBefore = [...open];
      const sentDuring: R[] = [];
      windows.add(sentDuring);
      let ended: PageAtReading<R> | undefined;
      return {
        end() {
          if (ended === undefined) {
            windows.delete(sentDuring);
            ended = { last: lastBefore, inFlight: [...openBefore, ...sentDuring] };
          }
          return ended;
        },
      };
    },
  };
}

/** What a step boundary was opened for: a step, with its record, a hook,
 * or a pause of `nuka run --step`. */
export type BoundarySender =
  | { readonly kind: "step"; readonly step: EventsProducerRecord }
  | { readonly kind: "hook" }
  | { readonly kind: "pause" };

/** One step boundary, compared by identity. `sender` is `undefined` for
 * the boundary a context opens with, the only one `nuka do` has. */
export interface PageBoundary {
  readonly sender: BoundarySender | undefined;
}

/** One request a page sent to the world, as the order holds it. */
export interface PageRequest {
  readonly request: PlaywrightRequest;
  readonly method: string;
  readonly url: string;
  /** The step boundary current when the page sent it. */
  readonly boundary: PageBoundary;
  /** `Date.now()` when each event arrived. */
  readonly sentAt: number;
  finishedAt?: number;
  failedAt?: number;
}

/** One page of the context as a reading found it: its place among the
 * context's open pages, from 1, its URL when the reading ended, and the
 * requests. */
export interface ContextPageAtReading extends PageAtReading<PageRequest> {
  readonly page: number;
  readonly url: string;
}

export interface PageOrderHandle {
  /** Opens a reading on every page the context has open. */
  begin(): { end(): ContextPageAtReading[] };
}

const COUNTED_KINDS: ReadonlySet<string> = new Set(["document", "fetch", "xhr"]);

/** Subscribes `context` so each page's requests to the world at `origin`
 * are kept in its order. `boundary` is read when a request is sent, so a
 * response that arrives after the next step began still belongs to the
 * step that sent it, as its http.jsonl line does (page-http-log.ts).
 * Called once, at browser-context creation. */
export function subscribePageOrder(context: BrowserContext, origin: string, boundary: () => PageBoundary): PageOrderHandle {
  const orders = new WeakMap<Page, PageOrder<PageRequest>>();
  const requests = new WeakMap<PlaywrightRequest, { readonly order: PageOrder<PageRequest>; readonly entry: PageRequest }>();
  const orderOf = (page: Page): PageOrder<PageRequest> => {
    let order = orders.get(page);
    if (order === undefined) {
      order = createPageOrder();
      orders.set(page, order);
    }
    return order;
  };
  context.on("request", (request) => {
    if (!COUNTED_KINDS.has(request.resourceType()) || !stampsUrl(origin, request.url())) return;
    let page: Page;
    try {
      page = request.frame().page();
    } catch {
      // A service worker's request has no frame, so no page drew from it.
      return;
    }
    const order = orderOf(page);
    const entry: PageRequest = { request, method: request.method(), url: request.url(), boundary: boundary(), sentAt: Date.now() };
    requests.set(request, { order, entry });
    order.sent(entry);
  });
  context.on("requestfinished", (request) => {
    const known = requests.get(request);
    if (known === undefined) return;
    known.entry.finishedAt = Date.now();
    known.order.finished(known.entry);
  });
  context.on("requestfailed", (request) => {
    const known = requests.get(request);
    if (known === undefined) return;
    known.entry.failedAt = Date.now();
    known.order.failed(known.entry);
  });
  return {
    begin() {
      const windows = new Map(context.pages().map((page) => [page, orderOf(page).begin()] as const));
      return {
        // A page that opened during the reading is read as it stood when
        // the reading ended.
        end: () =>
          context.pages().map((page, index) => ({
            page: index + 1,
            url: page.url(),
            ...(windows.get(page) ?? orderOf(page).begin()).end(),
          })),
      };
    },
  };
}

/** During which boundary `sent` was, seen from `current`. Pure. */
export function sentDuring(sent: PageBoundary, current: PageBoundary): PageRequestRecord["sent_during"] {
  if (sent === current) return "this-step";
  return sent.sender?.kind === "hook" ? "hook" : sent.sender?.kind === "pause" ? "pause" : "earlier-step";
}

/** The trace id of `traceparent`, lowercase, or `null` for a value that
 * is not one. Pure. */
export function traceIdOf(traceparent: string | null): string | null {
  const match = traceparent === null ? null : /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(traceparent.trim());
  return match === null ? null : match[1]!.toLowerCase();
}

// How long the record waits for an ended request's `traceparent`, which
// Playwright already holds then (module header).
const HEADER_WAIT_MS = 500;

/** `entry` as a claim step's record keeps it, seen from the boundary
 * `current` the record is written in. */
export async function pageRequestRecord(entry: PageRequest, current: PageBoundary): Promise<PageRequestRecord> {
  const ended = entry.finishedAt !== undefined || entry.failedAt !== undefined;
  const traceId = ended ? await traceIdWithin(entry.request, HEADER_WAIT_MS) : undefined;
  const during = sentDuring(entry.boundary, current);
  const sender = entry.boundary.sender;
  return {
    method: entry.method,
    url: entry.url,
    ...(traceId === undefined ? {} : { trace_id: traceId }),
    sent_at: new Date(entry.sentAt).toISOString(),
    finished_at: entry.finishedAt === undefined ? null : new Date(entry.finishedAt).toISOString(),
    ...(entry.failedAt === undefined ? {} : { failed_at: new Date(entry.failedAt).toISOString() }),
    sent_during: during,
    ...(during === "earlier-step" && sender?.kind === "step" ? { step: sender.step } : {}),
  };
}

/** The trace id the request went out with, `null` for none, or
 * `undefined` when Playwright did not say within `ms`. */
async function traceIdWithin(request: PlaywrightRequest, ms: number): Promise<string | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    const value = await Promise.race([request.headerValue("traceparent").catch(() => null), late]);
    return value === undefined ? undefined : traceIdOf(value);
  } finally {
    clearTimeout(timer);
  }
}
