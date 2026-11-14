import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { createPageOrder, type PageBoundary, sentDuring } from "../src/context/page-order.js";
import type { ClaimReading, PageReadingRecord } from "../src/record/types.js";
import { numberPageRequests } from "../src/step/evaluate-claims.js";

// Responsibility: what a page had received around a reading
// (src/context/page-order.ts), against a model that reads the whole list of
// events, and the numbering a claim step's record gives the requests its
// readings name (src/step/evaluate-claims.ts's `numberPageRequests`).

type Event =
  | { readonly kind: "sent" | "finished" | "failed"; readonly request: number }
  | { readonly kind: "begin" | "end"; readonly window: number };

const REQUESTS = 5;
const WINDOWS = 3;

const events = gs.arrays(
  gs.oneOf<Event>(
    gs.composite((tc) => ({ kind: tc.draw(gs.sampledFrom(["sent", "sent", "finished", "finished", "failed"] as const)), request: tc.draw(gs.integers({ minValue: 0, maxValue: REQUESTS - 1 })) })),
    gs.composite((tc) => ({ kind: tc.draw(gs.sampledFrom(["begin", "end"] as const)), window: tc.draw(gs.integers({ minValue: 0, maxValue: WINDOWS - 1 })) })),
  ),
  { minSize: 0, maxSize: 40 },
);

/** What the module header says a reading from event `begin` to event
 * `end` found, read off the whole list: the latest request whose response
 * finished while it was open, before `begin`, and every request open at
 * `begin` or sent before `end`, in the order sent. A request is sent once;
 * a later `sent` of it is no event. */
function model(list: readonly Event[], begin: number, end: number): { last: number | null; inFlight: number[] } {
  const sentAt = new Map<number, number>();
  const endedAt = new Map<number, number>();
  let last: number | null = null;
  list.forEach((event, index) => {
    if (!("request" in event)) return;
    if (event.kind === "sent") {
      if (!sentAt.has(event.request)) sentAt.set(event.request, index);
      return;
    }
    if (!sentAt.has(event.request) || endedAt.has(event.request)) return;
    endedAt.set(event.request, index);
    if (event.kind === "finished" && index < begin) last = event.request;
  });
  const inFlight = [...sentAt.entries()]
    .filter(([request, at]) => at < end && !((endedAt.get(request) ?? Infinity) < begin))
    .sort((a, b) => a[1] - b[1])
    .map(([request]) => request);
  return { last, inFlight };
}

describe("a page's order around a reading", () => {
  it("names the latest response that finished before the reading began, and every request open at some moment of it", () =>
    hegel.test((tc) => {
      const list = tc.draw(events);
      const order = createPageOrder<number>();
      const sent = new Set<number>();
      const open = new Map<number, { readonly begin: number; readonly window: ReturnType<typeof order.begin> }>();
      list.forEach((event, index) => {
        switch (event.kind) {
          case "sent":
            if (sent.has(event.request)) return;
            sent.add(event.request);
            order.sent(event.request);
            return;
          case "finished":
            order.finished(event.request);
            return;
          case "failed":
            order.failed(event.request);
            return;
          case "begin":
            if (!open.has(event.window)) open.set(event.window, { begin: index, window: order.begin() });
            return;
          case "end": {
            const reading = open.get(event.window);
            if (reading === undefined) return;
            open.delete(event.window);
            const found = reading.window.end();
            const expected = model(list, reading.begin, index);
            expect({ last: found.last, inFlight: [...found.inFlight] }).toEqual(expected);
            // A response that finished before the reading is never in flight in it.
            if (found.last !== null) expect(found.inFlight).not.toContain(found.last);
            return;
          }
        }
      });
    }, { testCases: 500 }));

  it("keeps what the first end found", () => {
    const order = createPageOrder<string>();
    order.sent("a");
    const reading = order.begin();
    expect(reading.end()).toEqual({ last: null, inFlight: ["a"] });
    order.finished("a");
    order.sent("b");
    expect(reading.end()).toEqual({ last: null, inFlight: ["a"] });
    expect(order.begin().end()).toEqual({ last: "a", inFlight: ["b"] });
  });
});

describe("which boundary a page sent a request in", () => {
  const step: PageBoundary = { sender: { kind: "step", step: { step_record_id: "step-1", step: "aki-opens-the-room", line: 4 } } };
  const hook: PageBoundary = { sender: { kind: "hook" } };
  const pause: PageBoundary = { sender: { kind: "pause" } };
  const opening: PageBoundary = { sender: undefined };

  it("is this step only for the boundary current now, compared by identity", () => {
    expect(sentDuring(step, step)).toBe("this-step");
    expect(sentDuring(opening, opening)).toBe("this-step");
    expect(sentDuring({ sender: step.sender }, step)).toBe("earlier-step");
    expect(sentDuring(step, hook)).toBe("earlier-step");
    expect(sentDuring(opening, step)).toBe("earlier-step");
    expect(sentDuring(hook, step)).toBe("hook");
    expect(sentDuring(pause, step)).toBe("pause");
  });
});

const pageOf = (last: number | null, inFlight: number[]): PageReadingRecord => ({ as: null, page: 1, url: "http://localhost:1/room", last_response: last, in_flight: inFlight });
const ids = gs.integers({ minValue: 0, maxValue: 30 });
const pageRecords = gs.arrays(
  gs.composite((tc) => pageOf(tc.draw(gs.oneOf<number | null>(gs.just(null), ids)), tc.draw(gs.arrays(ids, { minSize: 0, maxSize: 3 })))),
  { minSize: 0, maxSize: 3 },
);

describe("numberPageRequests", () => {
  it("numbers the requests from 0 in the order the record first names them, and every reference still names its request", () =>
    hegel.test((tc) => {
      const readings: ClaimReading[] = tc.draw(
        gs.arrays(
          gs.composite((inner) => {
            const pages = inner.draw(gs.oneOf<PageReadingRecord[] | undefined>(gs.just(undefined), pageRecords));
            return { attempt: 1, at: "2026-10-30T00:00:00.000Z", held: true, ...(pages === undefined ? {} : { pages }) };
          }),
          { minSize: 0, maxSize: 4 },
        ),
      );
      const pages = tc.draw(gs.oneOf<PageReadingRecord[] | undefined>(gs.just(undefined), pageRecords));
      const numbered = numberPageRequests(readings, pages);
      const named = (entries: readonly PageReadingRecord[]): number[] =>
        entries.flatMap((page) => [...(page.last_response === null ? [] : [page.last_response]), ...page.in_flight]);
      const before = [...readings.flatMap((reading) => named(reading.pages ?? [])), ...named(pages ?? [])];
      const after = [...(numbered.readings ?? []).flatMap((reading) => named(reading.pages ?? [])), ...named(numbered.pages ?? [])];
      expect(after.map((number) => numbered.order[number])).toEqual(before);
      expect(numbered.order).toEqual([...new Set(before)]);
      // Numbered in first-named order: each number first appears after every smaller one.
      expect([...new Set(after)]).toEqual(numbered.order.map((_, index) => index));
      expect(numbered.readings?.map((reading) => [reading.attempt, reading.held, reading.pages === undefined])).toEqual(readings.map((reading) => [reading.attempt, reading.held, reading.pages === undefined]));
    }));
});
