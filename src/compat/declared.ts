import { writeFileSync } from "node:fs";
import path from "node:path";

// Responsibility: the "declared" bucket (m2d-allure-shim task spec, decisions
// 2-3, 5) — what a step or its glue *reported about itself* through the
// allure-js runtime shim (src/compat/allure-runtime.ts) or a compat World's
// own `this.attach`/`log`/`link` channel (src/compat/world.ts), as opposed to
// `observed`/`used`/`world` (src/context/observed.ts, src/context/used.ts,
// src/compat/world-instrumentation.ts), which the harness itself measures.
//
// One `DeclaredCollector` object per pickle (src/run/run-scenario.ts creates
// it, alongside `contextHandle` and `worldInstrumentation`), never per-step:
// `beginStep` redirects where attachment files land and resets the five
// in-memory tallies, called at the exact points `contextHandle.beginStep`/
// `worldInstrumentation.beginStep` already are (before each Before/After
// hook, before each step) — the same "one object, mutable boundary" shape
// src/context/create-context.ts's own `httpLogDir` already uses. That one
// object reaches its two writers two different ways, both landing on the
// identical instance (this task's spec, item 2's kind-independence requirement):
// world.ts gets it passed directly, as a plain constructor parameter
// (`instantiateWorldForPickle`'s own `declaredCollector` argument) — a
// directly-passed object reference has no module-identity concerns, unlike
// a module-level variable would (world.ts is loaded through discovery's own
// scoped tsx import, a *different* module graph than run-scenario.ts's plain
// top-level one — see world.ts's own header for the empirical bug this
// avoided). allure-runtime.ts, by contrast, is a process-wide singleton
// registered once, with no per-pickle handle of its own to close over — it
// reaches "this pickle's own collector" only through the process-wide
// "active" pointer below, which src/run/run-scenario.ts repoints once per
// pickle. allure-runtime.ts is loaded via a plain top-level import (same
// module graph as run-scenario.ts), so that pointer is safe for it even
// though it would not have been for world.ts.
//
// Concurrency note: the active pointer is a genuine `globalThis`-adjacent
// singleton — two `runRun()` calls active at once in the *same process*
// would clobber each other's active collector.
// vitest's default worker-per-file isolation keeps this repo's own test
// suite safe;
// an in-process concurrent `nuka run` would need a different mechanism (e.g.
// `AsyncLocalStorage`) — out of scope for this slice.

export interface DeclaredLabel {
  readonly name: string;
  readonly value: string;
}

export interface DeclaredLink {
  readonly url: string;
  readonly name?: string;
  readonly type?: string;
}

export interface DeclaredParameter {
  readonly name: string;
  readonly value: string;
}

/** The receipt's own `declared` shape (src/receipt/types.ts) — every field
 * omitted when empty, the whole object omitted when every field is (this
 * task's spec, decision 5: omit the whole object when every field is empty). */
export interface DeclaredSnapshot {
  attachments?: string[];
  labels?: DeclaredLabel[];
  links?: DeclaredLink[];
  parameters?: DeclaredParameter[];
  logs?: string[];
}

export interface DeclaredCollector {
  /** Redirects attachment file writes to `dir` and resets every tally to
   * empty — call at the same step/hook boundary points
   * `contextHandle.beginStep`/`worldInstrumentation.beginStep` are called. */
  beginStep(dir: string): void;
  recordLabels(labels: readonly DeclaredLabel[]): void;
  recordLinks(links: readonly DeclaredLink[]): void;
  recordParameters(parameters: readonly DeclaredParameter[]): void;
  recordLog(text: string): void;
  /** Writes `content` under the current boundary's directory as `baseName`
   * (sanitized) + `extension` (already normalized, may be `""`), appending
   * `-2`, `-3`, ... on a name collision within the same boundary (this
   * task's spec, decision 3: a name collision gets a sequence number), then records the resulting
   * file name into this boundary's `attachments` tally. A no-op before the
   * first `beginStep()` ever runs (defensive; every real caller runs inside
   * a step or hook, which src/run/run-scenario.ts always begins first). */
  recordAttachment(baseName: string, content: Buffer, extension: string): void;
  /** What this boundary accumulated since the last `beginStep()`, or
   * `undefined` when nothing was recorded at all. */
  snapshot(): DeclaredSnapshot | undefined;
}

function sanitizeAttachmentBaseName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return cleaned.length > 0 ? cleaned : "attachment";
}

export function createDeclaredCollector(): DeclaredCollector {
  let currentDir: string | undefined;
  let attachments: string[] = [];
  let labels: DeclaredLabel[] = [];
  let links: DeclaredLink[] = [];
  let parameters: DeclaredParameter[] = [];
  let logs: string[] = [];
  let usedNames = new Map<string, number>();

  return {
    beginStep(dir: string): void {
      currentDir = dir;
      attachments = [];
      labels = [];
      links = [];
      parameters = [];
      logs = [];
      usedNames = new Map();
    },
    recordLabels(newLabels: readonly DeclaredLabel[]): void {
      labels.push(...newLabels);
    },
    recordLinks(newLinks: readonly DeclaredLink[]): void {
      links.push(...newLinks);
    },
    recordParameters(newParameters: readonly DeclaredParameter[]): void {
      parameters.push(...newParameters);
    },
    recordLog(text: string): void {
      logs.push(text);
    },
    recordAttachment(baseName: string, content: Buffer, extension: string): void {
      if (currentDir === undefined) {
        return;
      }
      const safeBase = sanitizeAttachmentBaseName(baseName);
      const key = `${safeBase}${extension}`;
      const count = usedNames.get(key) ?? 0;
      usedNames.set(key, count + 1);
      const fileName = count === 0 ? key : `${safeBase}-${count + 1}${extension}`;
      writeFileSync(path.join(currentDir, fileName), content);
      attachments.push(fileName);
    },
    snapshot(): DeclaredSnapshot | undefined {
      if (
        attachments.length === 0 &&
        labels.length === 0 &&
        links.length === 0 &&
        parameters.length === 0 &&
        logs.length === 0
      ) {
        return undefined;
      }
      return {
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
        ...(labels.length > 0 ? { labels: [...labels] } : {}),
        ...(links.length > 0 ? { links: [...links] } : {}),
        ...(parameters.length > 0 ? { parameters: [...parameters] } : {}),
        ...(logs.length > 0 ? { logs: [...logs] } : {}),
      };
    },
  };
}

let activeCollector: DeclaredCollector | undefined;

/** Executor-only (src/run/run-scenario.ts): repoints "the currently active
 * declared collector" — read by both allure-runtime.ts's registered
 * `TestRuntime` and world.ts's `attach`/`log`/`link` callbacks, so a facade
 * call and a World channel call in the same step land in the same place.
 * `undefined` between pickles (and whenever no `nuka run` is executing at
 * all), so a stray facade call outside any pickle's own execution safely
 * no-ops instead of writing into a stale collector. */
export function setActiveDeclaredCollector(collector: DeclaredCollector | undefined): void {
  activeCollector = collector;
}

export function getActiveDeclaredCollector(): DeclaredCollector | undefined {
  return activeCollector;
}

const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/xml": ".xml",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
};

/** A best-effort file extension for World's own `attach(data, mediaType)`
 * (this task's spec, item 4) — unlike the allure facade's `attachment()`,
 * cucumber-js's own `this.attach` never carries an explicit `fileExtension`,
 * so this is inferred from a short, common-case media-type table; anything
 * not listed gets no extension rather than a guess. */
export function extensionForMediaType(mediaType: string): string {
  return EXTENSION_BY_MEDIA_TYPE[mediaType] ?? "";
}

/** Normalizes the allure facade's own `AttachmentOptions.fileExtension`
 * (e.g. `"png"` or `".png"`, both seen in the wild — allure-js-commons' own
 * `typeToExtension` accepts either) to always carry a leading dot, or `""`
 * when none was given at all. */
export function normalizeFileExtension(ext: string | undefined): string {
  if (ext === undefined || ext.length === 0) {
    return "";
  }
  return ext.startsWith(".") ? ext : `.${ext}`;
}

/** Coerces World's own `attach(data, ...)` payload (cucumber-js accepts a
 * string, Buffer, or Uint8Array; a Readable stream is not supported by this
 * compat shim's synchronous callback shape — world.ts's own header) into the
 * bytes actually written to disk. Anything else is stringified defensively
 * rather than thrown: measurement must never crash a step (docs/spec.md,
 * migration-door rule). */
export function toAttachmentBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }
  try {
    return Buffer.from(JSON.stringify(data), "utf8");
  } catch {
    return Buffer.from(String(data), "utf8");
  }
}
