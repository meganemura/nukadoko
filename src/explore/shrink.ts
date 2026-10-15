// Responsibility: the choice-list shrinker a model run and a generated
// relation share. It first deletes one span of choices (one step's
// choices, when the caller knows the spans), then two adjacent spans,
// then lowers one choice at a time, and keeps an edit only when `attempt` says the rebuilt sequence
// still fails the same way. Each kept edit makes the choice list shorter,
// or the same length and lexicographically smaller, so shrinking ends.
// This is the choice-list shrinking Hypothesis uses, cut down to its
// simplest passes. This file does not know what a step, a model, or a
// relation is.

export const DEFAULT_MAX_SHRINK_ATTEMPTS = 200;

export interface Shrinkable {
  readonly choices: readonly number[];
  /** `[start, end)` of each step's choices in `choices`. */
  readonly spans: readonly (readonly [number, number])[];
}

/** Shortlex: fewer choices first, then the smaller choice at the first
 * difference. */
function simpler(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return a.length < b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}

function lowered(value: number): number[] {
  if (value === 0) return [];
  return [...new Set([0, Math.floor(value / 2), value - 1])];
}

/** `attempt` rebuilds a sequence from `choices` and returns it when it
 * fails the same way as `first`, or `undefined`. Each call counts as one
 * attempt. */
export async function shrinkChoices<T extends Shrinkable>(
  first: T,
  attempt: (choices: readonly number[]) => Promise<T | undefined>,
  limit: number = DEFAULT_MAX_SHRINK_ATTEMPTS,
): Promise<{ readonly best: T; readonly attempts: number }> {
  let best = first;
  let attempts = 0;

  async function tryChoices(choices: readonly number[]): Promise<boolean> {
    attempts += 1;
    const candidate = await attempt(choices);
    if (candidate === undefined || !simpler(candidate.choices, best.choices)) return false;
    best = candidate;
    return true;
  }

  let improved = true;
  while (improved && attempts < limit) {
    improved = false;
    const { spans, choices } = best;
    for (const [start, end] of spans) {
      if (attempts >= limit) break;
      if (await tryChoices([...choices.slice(0, start), ...choices.slice(end)])) {
        improved = true;
        break;
      }
    }
    if (improved) continue;
    // Two adjacent steps at once: a sequence can need both gone before it
    // fails the same way again, as when each step undoes the other.
    for (const [index, [start]] of spans.entries()) {
      if (attempts >= limit || index + 1 >= spans.length) break;
      const end = spans[index + 1]![1];
      if (await tryChoices([...choices.slice(0, start), ...choices.slice(end)])) {
        improved = true;
        break;
      }
    }
    if (improved) continue;
    outer: for (const [position, value] of choices.entries()) {
      for (const candidate of lowered(value)) {
        if (attempts >= limit) break outer;
        const edited = [...choices];
        edited[position] = candidate;
        if (await tryChoices(edited)) {
          improved = true;
          break outer;
        }
      }
    }
  }
  return { best, attempts };
}
