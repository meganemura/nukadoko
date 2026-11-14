// Responsibility: the name a step gives a browser context of its own through
// `pageAs(name)` (docs/spec.md "Context API"), and the evidence file names
// that name produces. Pure: no Playwright, no filesystem. create-context.ts
// opens the contexts; this module only decides which names are valid and
// where each one's files go.
//
// A name is part of a file name (`trace.aki.zip`, `final.aki.png`) in the
// same directory as the default context's own `trace.zip` and `final.png`.
// That is why the rule is narrow: lowercase letters, digits, and hyphens
// only. An uppercase letter would let `Aki` and `aki` land on one file on a
// case-insensitive volume, and a dot or a separator would let a name reach
// another harness file or another directory. A name outside the rule is
// refused, never rewritten, the same choice `evidence.attach` makes for its
// own names.

const CONTEXT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Longest name `pageAs` accepts. A name lands in two file names per step
 * directory, and a long one would push those past what a file system
 * allows. */
export const MAX_CONTEXT_NAME_LENGTH = 64;

/** Thrown by `pageAs(name)` for a name this module's rule refuses. */
export class InvalidContextNameError extends Error {
  readonly contextName: unknown;

  constructor(name: unknown) {
    super(
      `pageAs() name ${JSON.stringify(name)} is not valid. Use 1 to ${MAX_CONTEXT_NAME_LENGTH} ` +
        "lowercase letters, digits, and hyphens, starting with a letter or a digit: the name " +
        "becomes part of evidence file names such as trace.<name>.zip.",
    );
    this.name = "InvalidContextNameError";
    this.contextName = name;
  }
}

export function isValidContextName(name: unknown): name is string {
  return typeof name === "string" && name.length <= MAX_CONTEXT_NAME_LENGTH && CONTEXT_NAME.test(name);
}

export function assertValidContextName(name: unknown): asserts name is string {
  if (!isValidContextName(name)) {
    throw new InvalidContextNameError(name);
  }
}

/** The file a named context writes where the default context writes
 * `base`: the name goes before the last extension, so `trace.zip` becomes
 * `trace.aki.zip` and `hook-before-1.zip` becomes `hook-before-1.aki.zip`.
 * `as` undefined is the default context, which keeps `base` unchanged. */
export function contextFileName(base: string, as: string | undefined): string {
  if (as === undefined) {
    return base;
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return `${base}.${as}`;
  }
  return `${base.slice(0, dot)}.${as}${base.slice(dot)}`;
}

/** Whether `fileName` is a file a named context writes into a step record
 * directory (`trace.<name>.zip`, `final.<name>.png`). Compared without case,
 * for the same reason `evidence.attach` compares its reserved names without
 * case. */
export function isNamedContextHarnessFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  for (const [prefix, suffix] of [
    ["trace.", ".zip"],
    ["final.", ".png"],
  ] as const) {
    if (lower.startsWith(prefix) && lower.endsWith(suffix)) {
      const middle = lower.slice(prefix.length, lower.length - suffix.length);
      if (isValidContextName(middle)) {
        return true;
      }
    }
  }
  return false;
}

/** The options `pageAs` compares a later call against: a copy, so a caller
 * that mutates its own object after the first call cannot change what the
 * context was opened with, and with every `undefined`-valued key dropped,
 * since Playwright reads `{ viewport: undefined }` the same as `{}`. Plain
 * objects and arrays are copied all the way down; any other value (a
 * function, a class instance) is kept as it is, because it cannot be
 * copied without changing what it is. */
export function snapshotContextOptions(options: object | undefined): Record<string, unknown> {
  return (options === undefined ? {} : snapshotValue(options)) as Record<string, unknown>;
}

function snapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snapshotValue);
  }
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const copy: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== undefined) {
        copy[key] = snapshotValue(inner);
      }
    }
    return copy;
  }
  return value;
}

/** Thrown by `pageAs(name, options)` when `name` is already open in this
 * scenario with other options. A context's options are fixed when
 * Playwright creates it, so the second set could only be ignored, and an
 * ignored `javaScriptEnabled: false` would let a step believe scripts are
 * off while they run. */
export class ContextOptionsConflictError extends Error {
  readonly contextName: string;

  constructor(name: string) {
    super(
      `pageAs(${JSON.stringify(name)}) already opened that context in this scenario with other ` +
        "options. A context keeps the options it was created with: pass the same options, or " +
        "none, on a later call.",
    );
    this.name = "ContextOptionsConflictError";
    this.contextName = name;
  }
}

/** The file a boundary's `showRequests` screen is traced to
 * (request-stage.ts), beside the chunk file the boundary's own page
 * writes: `requests.zip` for a step's `trace.zip`,
 * `hook-before-1-requests.zip` for a hook's `hook-before-1.zip`. A hyphen,
 * not a dot, so it never meets a `pageAs(name)` file such as
 * `trace.requests.zip`. */
export function requestsTraceFileName(chunkFileName: string): string {
  return chunkFileName === "trace.zip" ? "requests.zip" : chunkFileName.replace(/\.zip$/, "-requests.zip");
}
