import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseHttpLog, type HttpLogEntry } from "../src/context/http-log-read.js";
import type { PageErrorEntry, PageEventsSnapshot } from "../src/record/types.js";
import { underneathOfRecord } from "../src/run/underneath.js";

// Responsibility: what run.json's `steps[].underneath` holds of one step
// record: every http.jsonl line with a status from 500 to 599, grouped by
// status and none lost, every page error grouped by name, and what could
// not be seen counted apart; and the one http.jsonl parser reads back each
// line a writer wrote, at the index a reader names it by.

const via = gs.sampledFrom(["request", "page", "fetch", "node:http", "node:https"] as const);
const status = gs.oneOf(gs.sampledFrom([0, 200, 302, 404, 499, 500, 503, 599, 600]), gs.integers({ minValue: 100, maxValue: 699 }));
const entry = gs.tuples(gs.sampledFrom(["GET", "POST"]), gs.sampledFrom(["http://a.test/x", "http://b.test/y?z=1"]), status, via).map(
  ([method, url, code, through]): HttpLogEntry => ({ method, url, status: code, duration_ms: 1, via: through }),
);
const line = gs.oneOf(entry, gs.just(null));
const pageError = gs.tuples(gs.optional(gs.sampledFrom(["Error", "TypeError"])), gs.sampledFrom(["boom", "line one\nline two"])).map(
  ([name, message]): PageErrorEntry => ({ ...(name === null || name === undefined ? {} : { name }), message, at: "2026-11-04T00:00:00.000Z" }),
);

function failed(code: number): boolean {
  return code >= 500 && code <= 599;
}

describe("underneath of a step record", () => {
  it("groups every line with a status from 500 to 599 by status, ascending, and counts each one", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(line, { maxSize: 12 }));
      const groups = underneathOfRecord(undefined, lines, undefined)?.statuses ?? [];
      const expected = [...new Set(lines.flatMap((entry) => (entry !== null && failed(entry.status) ? [entry.status] : [])))].sort((a, b) => a - b);
      expect(groups.map((group) => group.status)).toEqual(expected);
      for (const group of groups) {
        const at = lines.findIndex((entry) => entry?.status === group.status);
        expect(group.count).toBe(lines.filter((entry) => entry?.status === group.status).length);
        expect(group.first).toEqual({ method: lines[at]!.method, url: lines[at]!.url, via: lines[at]!.via, http_line: at });
      }
    }));

  it("finds the same groups and counts in whatever order the lines are", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(line, { maxSize: 10 }));
      const shuffled = [...lines].reverse();
      const counts = (groups: ReturnType<typeof underneathOfRecord>) => (groups?.statuses ?? []).map((group) => [group.status, group.count]);
      expect(counts(underneathOfRecord(undefined, shuffled, undefined))).toEqual(counts(underneathOfRecord(undefined, lines, undefined)));
    }));

  it("counts lines that do not parse and appends that failed as unseen, never as a failure", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(line, { maxSize: 10 }));
      const appendsFailed = tc.draw(gs.optional(gs.integers({ minValue: 0, maxValue: 3 }))) ?? undefined;
      const unseen = lines.filter((entry) => entry === null).length + (appendsFailed ?? 0);
      const underneath = underneathOfRecord(undefined, lines, appendsFailed);
      expect(underneath?.unseen?.http_lines).toBe(unseen === 0 ? undefined : unseen);
      expect(underneathOfRecord(undefined, null, appendsFailed)?.unseen).toEqual({ http_lines: null });
    }));

  it("groups page errors by name in the order the first of each arrived, with a nameless one under null", () =>
    hegel.test((tc) => {
      const errors = tc.draw(gs.arrays(pageError, { minSize: 1, maxSize: 8 }));
      const groups = underneathOfRecord({ page_errors: errors }, [], undefined)?.page_errors ?? [];
      const names = [...new Set(errors.map((error) => error.name ?? null))];
      expect(groups.map((group) => group.name)).toEqual(names);
      expect(groups.reduce((total, group) => total + group.count, 0)).toBe(errors.length);
      for (const group of groups) {
        const first = errors.find((error) => (error.name ?? null) === group.name)!;
        expect(group.first.message).toBe(first.message.split("\n")[0]);
      }
    }));

  it("counts the page errors past the record's cap as unseen", () => {
    const kept: PageErrorEntry[] = Array.from({ length: 100 }, () => ({ name: "Error", message: "x", at: "2026-11-04T00:00:00.000Z" }));
    const snapshot: PageEventsSnapshot = { page_errors: kept, truncated: { page_errors: 130 } };
    expect(underneathOfRecord(snapshot, [], undefined)).toEqual({
      page_errors: [{ name: "Error", count: 100, first: { message: "x" } }],
      unseen: { page_errors: 30 },
    });
  });

  it("is absent for a step that saw no failure and missed nothing", () => {
    expect(underneathOfRecord({ console_errors: [] }, [{ method: "GET", url: "http://a.test/", status: 200, duration_ms: 1, via: "page" }], 0)).toBeUndefined();
  });
});

describe("parseHttpLog", () => {
  it("reads back every line a writer wrote, at its index, and a line that is not one as null", () =>
    hegel.test((tc) => {
      const lines = tc.draw(gs.arrays(gs.oneOf<HttpLogEntry | string>(entry, gs.sampledFrom(["not json", "[1]", "{\"status\":500}", "null"])), { maxSize: 8 }));
      const text = lines.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
      const ending = tc.draw(gs.sampledFrom(["", "\n"]));
      expect(parseHttpLog(`${text}${ending}`)).toEqual(lines.map((value) => (typeof value === "string" ? null : value)));
    }));
});
