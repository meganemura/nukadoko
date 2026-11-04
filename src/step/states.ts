import type { z } from "zod";

// Responsibility: the states a step declares (docs/spec.md "States"):
// what `requires`, `gives`, and `ends` hold, read once while defineStep
// runs, and refused there when an entry is not a state a line can hold.
// Boundary: knows nothing of feature files, pickles, or the vocabulary.
// Judging a scenario against these declarations is
// src/check/state-order.ts.

/** A state a step names: its name alone, for a state a scenario holds
 * once ("book-open"), or its name and the args key whose value on the
 * line tells one holder from another (["signed-in", "person"]: signed in
 * as aki is not signed in as ben). The pair is `from`'s own
 * [thing, "key"] shape. */
export type StateRef<K extends string = string> = string | readonly [state: string, key: K];

/** The args keys a keyed StateRef may name. `never` when args is not a
 * z.object, so a keyed entry on such a step does not compile. */
export type StateKey<TArgs extends z.ZodTypeAny> = TArgs extends z.ZodObject<infer Shape>
  ? Extract<keyof Shape, string>
  : never;

/** One entry as a step holds it. `key` is undefined for an unkeyed state. */
export interface StateUse {
  readonly state: string;
  readonly key: string | undefined;
}

/** What one step declares. An empty list and an absent one mean the same
 * thing: the step names no state there. */
export interface StepStates {
  readonly requires: readonly StateUse[];
  readonly gives: readonly StateUse[];
  readonly ends: readonly StateUse[];
}

export const STATE_LISTS = ["requires", "gives", "ends"] as const;

export type StateList = (typeof STATE_LISTS)[number];

/** `signed-in for person`, or `book-open`: how nuka steps names an entry. */
export function describeStateUse(use: StateUse): string {
  return use.key === undefined ? use.state : `${use.state} for ${use.key}`;
}

function quotedUse(use: StateUse): string {
  return use.key === undefined ? JSON.stringify(use.state) : `[${JSON.stringify(use.state)}, ${JSON.stringify(use.key)}]`;
}

const ENTRY_FORMS = 'a name ("signed-in") or a [name, key] pair (["signed-in", "person"])';

/**
 * Reads the three lists from the frozen copy defineStep made, against the
 * keys of `args` (`null` when args is not a z.object). The problem names
 * the entry, in the words defineStep throws: an entry that is neither
 * form, a name that is empty or has space at either end, a key args does
 * not declare, one entry twice in a list, and one entry in both gives and
 * ends, since a step leaves a state one way. A claim step's gives and ends
 * are refused before this runs, with the other options a claim step has
 * no use for.
 */
export function readStates(
  definition: { readonly [L in StateList]?: unknown },
  argsKeys: ReadonlySet<string> | null,
): { readonly states: StepStates } | { readonly problem: string } {
  const read: Partial<Record<StateList, readonly StateUse[]>> = {};
  for (const list of STATE_LISTS) {
    const value = definition[list];
    if (value === undefined) {
      read[list] = Object.freeze([]);
      continue;
    }
    if (!Array.isArray(value)) return { problem: `${list} must be an array of states, each ${ENTRY_FORMS}` };
    const uses: StateUse[] = [];
    for (const [index, entry] of value.entries()) {
      const at = `${list}[${index}]`;
      const use = entryUse(entry);
      if (use === null) return { problem: `${at} is not a state: write ${ENTRY_FORMS}` };
      if (use.state === "" || use.state.trim() !== use.state) {
        return { problem: `${at} names the state ${JSON.stringify(use.state)}, and a state name is not empty and has no space at either end` };
      }
      if (use.key !== undefined && !argsKeys?.has(use.key)) {
        const declared =
          argsKeys === null
            ? "args is not a z.object, so a state on this step cannot name a key"
            : argsKeys.size === 0
              ? "args declares no key"
              : `args declares ${[...argsKeys].map((key) => JSON.stringify(key)).join(", ")}`;
        return { problem: `${at} names args key ${JSON.stringify(use.key)}, which args does not declare: ${declared}` };
      }
      const earlier = uses.findIndex((other) => sameUse(other, use));
      if (earlier !== -1) return { problem: `${at} repeats ${quotedUse(use)} from ${list}[${earlier}]` };
      uses.push(Object.freeze(use));
    }
    read[list] = Object.freeze(uses);
  }
  const gives = read.gives!;
  const ends = read.ends!;
  for (const [index, use] of gives.entries()) {
    const ended = ends.findIndex((other) => sameUse(other, use));
    if (ended !== -1) {
      return { problem: `gives[${index}] and ends[${ended}] both name ${quotedUse(use)}, and a step leaves a state one way` };
    }
  }
  return { states: Object.freeze({ requires: read.requires!, gives, ends }) };
}

function entryUse(entry: unknown): StateUse | null {
  if (typeof entry === "string") return { state: entry, key: undefined };
  if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string") {
    return { state: entry[0], key: entry[1] };
  }
  return null;
}

function sameUse(a: StateUse, b: StateUse): boolean {
  return a.state === b.state && a.key === b.key;
}
