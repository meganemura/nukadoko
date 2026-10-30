import { types } from "node:util";
import { readKey, type AriaSnapshotRead } from "../step/evaluate-claims.js";
import { kindOf, valueAt } from "../step/snapshot.js";

// Responsibility: the ARIA snapshots a claim step's `fits-aria-snapshot`
// claims judge (docs/spec.md "Claims"). For each path into what `observe`
// returned that such a claim names, it finds the value there and, when the
// value is a locator or a page, asks the browser for its ARIA snapshot
// through the value's own `ariaSnapshot()`, so the tree a claim judges is
// the one the browser library prints and nukadoko measured, never a text
// step code wrote. The claim runner calls it once per reading, right after
// `observe` returned and its plain snapshots were taken. It does not judge
// a tree (src/step/aria-snapshot.ts does) and does not decide when a
// reading happens.
//
// The value is found without running any code of its own (own data
// properties only, no getter, no Proxy trap), and its `ariaSnapshot` is
// found the same way on its prototypes, so the one call into it is the
// snapshot itself. No timeout is passed: the snapshot waits for a locator
// as any read in `observe` would, for the page's own timeout (30 seconds
// unless the step set another), and the step's deadline bounds it as it
// bounds `observe`. A timeout tied to a poll's end was refused: near the
// end it leaves a few milliseconds, and on Playwright 1.61.1 a snapshot of
// an element that is there failed under a timeout of 5 ms, so the last
// reading of a page that holds would end unjudged.

/** The phrase a claim's reason gives for a value that is not one, after
 * the place's name: `observe:page is a string`. */
function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return `a ${typeof value}`;
  return kindOf(value);
}

/** The `ariaSnapshot` function on `value`'s prototypes, found by
 * descriptor, or `null` when none is a plain method. A getter there is
 * code of the value's own, so it is never called to find one. */
function ariaSnapshotMethod(value: object): ((options?: object) => unknown) | null {
  for (let current: object | null = value; current !== null; current = Object.getPrototypeOf(current) as object | null) {
    if (types.isProxy(current)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(current, "ariaSnapshot");
    if (descriptor === undefined) continue;
    return "value" in descriptor && typeof descriptor.value === "function" ? (descriptor.value as (options?: object) => unknown) : null;
  }
  return null;
}

/** The first line of what the browser threw, without the full stop the
 * reason's own clause follows it with. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n")[0] ?? "").replace(/\.$/, "");
}

const TAKES = "fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns: return the locator or page itself, and nukadoko takes its snapshot";

/** The ARIA snapshot of the value at one path inside `root`. */
async function ariaSnapshotAt(root: unknown, segments: readonly string[]): Promise<AriaSnapshotRead> {
  const found = valueAt(root, segments);
  if ("missing" in found) return { broken: "is undefined" };
  if ("refused" in found) {
    const { at, problem } = found.refused;
    if (at.length === segments.length) return { unjudged: `${problem}, which nukadoko does not read, so the claim was not judged` };
    const through = at.length === 0 ? "what observe returned" : at.join(".");
    return { unjudged: `is reached through ${through}, which ${problem}, so nukadoko did not read it and the claim was not judged` };
  }
  const value = found.found;
  if (typeof value === "object" && value !== null && types.isProxy(value)) {
    return { unjudged: "is a Proxy, whose ariaSnapshot nukadoko does not call, so the claim was not judged" };
  }
  const method = typeof value === "object" && value !== null ? ariaSnapshotMethod(value) : null;
  if (method === null) return { broken: `is ${valueKind(value)}, and ${TAKES}` };
  let text: unknown;
  try {
    text = await Reflect.apply(method, value, []);
  } catch (error) {
    return { unjudged: `gave no ARIA snapshot: ${firstLine(error)}, so the claim was not judged` };
  }
  if (typeof text !== "string") return { unjudged: `gave ${valueKind(text)} from ariaSnapshot() rather than a text, so the claim was not judged` };
  return { text };
}

/** The ARIA snapshot of the value at each path, by `readKey`. One path's
 * failure is that path's read, so taking them never throws. */
export async function takeAriaSnapshots(root: unknown, paths: readonly (readonly string[])[]): Promise<ReadonlyMap<string, AriaSnapshotRead>> {
  const taken = new Map<string, AriaSnapshotRead>();
  for (const segments of paths) taken.set(readKey(segments), await ariaSnapshotAt(root, segments));
  return taken;
}

/** A reader over the snapshots `takeAriaSnapshots` took. A path it took
 * none of leaves its claim unjudged: a claim never reads a live value. */
export function ariaSnapshotReader(taken: ReadonlyMap<string, AriaSnapshotRead>): (segments: readonly string[]) => AriaSnapshotRead {
  return (segments) => taken.get(readKey(segments)) ?? { unjudged: "has no ARIA snapshot nukadoko took, so the claim was not judged" };
}
