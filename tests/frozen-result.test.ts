import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { z } from "zod";
import { assessFrozenResult } from "../src/tend/signoff-rot.js";

// A frozen result is JSON. z.date() accepts a Date, and JSON.stringify
// writes that Date as an ISO string. The comparison has to accept that
// string, and it has to keep rejecting a value that is not the JSON form
// of a Date.

const DATE_MS_LIMIT = 8_640_000_000_000_000;

describe("assessFrozenResult", () => {
  it("accepts the ISO string JSON.stringify writes for a Date", () => {
    const schema = z.object({ createdAt: z.date() });
    const frozen = { createdAt: "2026-01-02T03:04:05.000Z" };
    expect(assessFrozenResult(schema, frozen)).toEqual({ ok: true });
  });

  it("rejects an empty object where a Date was recorded", () => {
    const schema = z.object({ createdAt: z.date() });
    const assessed = assessFrozenResult(schema, { createdAt: {} });
    expect(assessed.ok).toBe(false);
    if (!assessed.ok) {
      expect(assessed.detail).toContain("createdAt");
      expect(assessed.detail).toContain("date");
    }
  });

  it("still rejects a result the schema does not accept", () => {
    const schema = z.object({ total: z.string(), currency: z.string() });
    const assessed = assessFrozenResult(schema, { total: "27" });
    expect(assessed.ok).toBe(false);
    if (!assessed.ok) expect(assessed.detail).toContain("currency");
  });

  it("accepts the JSON form of any Date the schema accepts", () => {
    hegel.test((tc) => {
      const ms = tc.draw(gs.integers({ minValue: -DATE_MS_LIMIT, maxValue: DATE_MS_LIMIT }));
      const date = new Date(ms);
      const schema = z.object({
        createdAt: z.date(),
        notes: z.array(z.date()),
      });
      const frozen = JSON.parse(JSON.stringify({ createdAt: date, notes: [date] }));
      expect(assessFrozenResult(schema, frozen)).toEqual({ ok: true });
    });
  });
});
