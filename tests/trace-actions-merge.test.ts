import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { MAX_ACTIONS, mergeContextActions, type ContextActions } from "../src/context/trace-actions.js";
import type { ActionEntry } from "../src/record/types.js";

// Responsibility: `mergeContextActions` puts the actions of the default
// context and every `pageAs(name)` context of one step on one timeline. The
// result is ordered by `at`, never longer than one trace's cap, holds the
// earliest actions overall, and says how many there were when it had to
// drop some.

function action(index: number, at: number, as: string | undefined): ActionEntry {
  return {
    method: `call-${index}`,
    ms: 1,
    outcome: "passed",
    at: new Date(Date.UTC(2026, 0, 1) + at).toISOString(),
    ...(as !== undefined ? { as } : {}),
  };
}

// One source as a trace parse would give it: in time order, at most
// `MAX_ACTIONS` kept, `total` the count before the cap.
const source = (as: string | undefined): gs.Generator<ContextActions> =>
  gs.arrays(gs.integers({ minValue: 0, maxValue: 10_000 }), { minSize: 0, maxSize: 160 }).map((times) => {
    const sorted = [...times].sort((a, b) => a - b);
    return {
      actions: sorted.slice(0, MAX_ACTIONS).map((at, index) => action(index, at, as)),
      total: sorted.length,
    };
  });

describe("mergeContextActions", () => {
  it("orders, caps, and counts the actions of every context", () =>
    hegel.test((tc) => {
      const sources = [tc.draw(source(undefined)), tc.draw(source("aki")), tc.draw(source("ben"))];
      const { actions, truncatedCount } = mergeContextActions(sources);
      const total = sources.reduce((sum, s) => sum + s.total, 0);

      expect(actions.length).toBe(Math.min(MAX_ACTIONS, sources.reduce((sum, s) => sum + s.actions.length, 0)));
      expect(truncatedCount).toBe(total > MAX_ACTIONS ? total : undefined);
      for (let i = 1; i < actions.length; i++) {
        expect(actions[i - 1]!.at <= actions[i]!.at).toBe(true);
      }
      const every = sources.flatMap((s) => s.actions);
      for (const kept of actions) {
        expect(every).toContain(kept);
      }
      const last = actions[actions.length - 1];
      if (last !== undefined && actions.length === MAX_ACTIONS) {
        const earlierLeftOut = every.filter((a) => !actions.includes(a) && a.at < last.at);
        expect(earlierLeftOut).toEqual([]);
      }
    }));

  it("returns one source's actions unchanged", () =>
    hegel.test((tc) => {
      const only = tc.draw(source(undefined));
      const { actions, truncatedCount } = mergeContextActions([only]);
      expect(actions).toEqual(only.actions);
      expect(truncatedCount).toBe(only.total > MAX_ACTIONS ? only.total : undefined);
    }));
});
