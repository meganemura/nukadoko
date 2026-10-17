import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseLiveResponse } from "../src/live/protocol.js";

// Responsibility: parseLiveResponse is a pure narrowing of one JSON value
// onto the live-session reply union. The properties cover the values a
// single example would leave out: any safe unknown status is named, a
// failure detail stays one line even when the status contains a newline,
// and a record reply's record object is returned as it arrived.

const safeStatus = gs.text({ alphabet: "abcxyz-", minSize: 1, maxSize: 24 });
const shortText = gs.text({ alphabet: "abc ", minSize: 0, maxSize: 40 });

describe("parseLiveResponse", () => {
  it("names a safe status outside the reply union", () =>
    hegel.test((tc) => {
      const status = tc.draw(safeStatus);
      tc.assume(status !== "record" && status !== "rejected" && status !== "stopped");
      expect(parseLiveResponse({ status })).toEqual({ ok: false, message: `status "${status}"` });
    }));

  it("keeps an unrecognized-reply detail on one line", () =>
    hegel.test((tc) => {
      const status = tc.draw(gs.text());
      const parsed = parseLiveResponse({ status });
      if (!parsed.ok) {
        expect(parsed.message.includes("\n")).toBe(false);
        expect(parsed.message.includes("\r")).toBe(false);
      }
    }));

  it("rejects a value that is not a reply object", () =>
    hegel.test((tc) => {
      const value = tc.draw(
        gs.composite((draw) => {
          const kind = draw.draw(gs.integers({ minValue: 0, maxValue: 3 }));
          if (kind === 0) return null;
          if (kind === 1) return draw.draw(gs.booleans());
          if (kind === 2) return draw.draw(gs.integers({ minValue: -3, maxValue: 3 }));
          return draw.draw(gs.text({ alphabet: "ab", minSize: 0, maxSize: 4 }));
        }),
      );
      expect(parseLiveResponse(value)).toEqual({ ok: false, message: "no known status" });
    }));

  it("rejects an array", () =>
    hegel.test((tc) => {
      const value = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 2 }), { minSize: 0, maxSize: 3 }));
      expect(parseLiveResponse(value)).toEqual({ ok: false, message: "no known status" });
    }));

  it("returns a record reply's record unchanged", () =>
    hegel.test((tc) => {
      const step = tc.draw(gs.text({ alphabet: "abc", minSize: 1, maxSize: 8 }));
      const sessionExecution = tc.draw(gs.integers({ minValue: 0, maxValue: 20 }));
      const record = { status: "passed", step, session_execution: sessionExecution };
      const parsed = parseLiveResponse({ status: "record", record });
      if (!parsed.ok || parsed.response.status !== "record") {
        throw new Error("expected a record reply");
      }
      expect(parsed.response.record).toBe(record);
    }));

  it("keeps a rejection message as given", () =>
    hegel.test((tc) => {
      const message = tc.draw(shortText);
      expect(parseLiveResponse({ status: "rejected", message })).toEqual({
        ok: true,
        response: { status: "rejected", message },
      });
    }));

  it("accepts a stop reply and ignores extra fields", () =>
    hegel.test((tc) => {
      const extra = tc.draw(gs.booleans());
      expect(parseLiveResponse({ status: "stopped", extra })).toEqual({
        ok: true,
        response: { status: "stopped" },
      });
    }));
});
