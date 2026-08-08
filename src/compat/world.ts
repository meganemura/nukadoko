import type { APIRequestContext, Page } from "playwright";
import type { z } from "zod";
import type { StepContext } from "../context.js";
import { extensionForMediaType, toAttachmentBuffer, type DeclaredCollector } from "./declared.js";
import { WorldNotOpenedError } from "./errors.js";
import { instrumentWorld, type WorldInstrumentationHandle } from "./world-instrumentation.js";

// Responsibility: cucumber-js's own World shape (a single-argument
// constructor receiving `{ attach, log, link, parameters }`, all four just
// own writable data properties at run time despite being typed readonly
// upstream) plus the harness's own two-tier page/request access:
//
//   - Glue that launches its own Playwright is left alone entirely — it
//     isn't reachable through this class at all, and nukadoko never
//     measures it (docs/spec.md, migration-door rule: don't break a working
//     asset).
//   - The *measured* door is `await this.openPage()` / `await
//     this.openRequest()`, delegating to the same `ctx.page()`/
//     `ctx.request()` a typed step's `ctx` exposes (context/create-
//     context.ts) — same lazy launch, same memoization, so a compat step
//     and a typed step sharing one pickle share one browser/request context
//     automatically. Once opened, `this.page`/`this.request` return
//     synchronously; accessing either before its `open*()` counterpart
//     resolves is a mistake this class refuses to paper over with
//     `undefined` (WorldNotOpenedError names the fix instead).
//
// `attach`/`log`/`link` route into this pickle's own declared collector —
// the same object src/run/run-scenario.ts creates and passes into
// `instantiateWorldForPickle` below as a
// plain parameter (`declaredCollector`, captured directly in the closures
// that build `attach`/`log`/`link`), never read back out through src/compat/
// declared.ts's own module-level "active collector" pointer the way the
// allure-js runtime shim itself does (src/compat/allure-runtime.ts). That
// distinction matters here specifically: this file is loaded through
// discovery's own scoped tsx import (see the module-identity note below),
// which gives it its own separate instance of every module it transitively
// imports, `declared.ts` included — so a plain top-level module-level
// variable declared.ts exports would not be the *same* variable src/run/
// run-scenario.ts's own (plain top-level) import writes to. A directly-
// passed object reference has no such problem: calling a method on it always
// reaches the exact closures `createDeclaredCollector()` built, regardless
// of which module instance's import statement is holding the reference.
// allure-runtime.ts has no such constraint (it's loaded once, via a plain
// top-level import from src/cli/run.ts, same graph as run-scenario.ts), so
// its own indirection through the active-collector pointer is safe.
//
// Module-identity note (same shape as src/compat/registry.ts's own header):
// `runtimeByWorld` (the ctx bridge) is keyed by the constructed instance, in
// a WeakMap private to *this* module — so whichever module instance a
// user's `class MyWorld extends World` resolved "nukadoko/compat" to (src/
// discover/discover-steps.ts's scoped tsx import during discovery) is the
// exact instance whose `openPage()`/`get page()` methods close over the
// matching WeakMap. src/discover/discover-steps.ts captures
// `instantiateWorldForPickle` itself through that same scoped import, rather
// than a plain top-level one, for exactly this reason — see that file's own
// header for the mechanism this mirrors; `ctx` itself is threaded the same
// directly-passed-parameter way `declaredCollector` now is, for the same
// module-identity reason.

export interface WorldConstructorParams {
  readonly attach: (data: unknown, mediaType?: string) => void;
  readonly log: (text: string) => void;
  readonly link: (url: string, text?: string) => void;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * `WorldConstructorParams` under cucumber-js's own name (the compat audit
 * found `IWorldOptions` appears in 2/2 real-world repos' glue as a bare
 * type import, e.g. `import { type
 * IWorldOptions } from "nukadoko/compat"`). Without this alias that import
 * fails `tsc` while `nuka run`/`nuka check` stay silent — a type-only import
 * gets stripped by esbuild before either ever sees it — so this alias closes
 * a gap only the caller's own typechecker could see.
 *
 * Deliberately **not** generic, unlike cucumber-js's own
 * `IWorldOptions<ParametersType>`: `parameters` here is always
 * `Readonly<Record<string, unknown>>` (see `WorldConstructorParams` above)
 * regardless of what a caller writes as a type argument, and this project's
 * `World` isn't itself generic — accepting a type parameter and ignoring it
 * would make `IWorldOptions<Foo>` typecheck while silently not doing what it
 * looks like it does. Glue written that way gets a real `tsc` error instead;
 * that's intentional (docs/spec.md, migration-door rule: something
 * unsupported should fail loudly, not pass quietly).
 */
export type IWorldOptions = WorldConstructorParams;

export type WorldConstructor = new (params: WorldConstructorParams) => World;

const runtimeByWorld = new WeakMap<World, StepContext>();
const pageByWorld = new WeakMap<World, Page>();
const requestByWorld = new WeakMap<World, APIRequestContext>();

export class World {
  readonly attach: WorldConstructorParams["attach"];
  readonly log: WorldConstructorParams["log"];
  readonly link: WorldConstructorParams["link"];
  readonly parameters: WorldConstructorParams["parameters"];

  constructor(params: WorldConstructorParams) {
    this.attach = params.attach;
    this.log = params.log;
    this.link = params.link;
    this.parameters = params.parameters;
  }

  /** The Page this pickle's own `await this.openPage()` opened.
   * @throws {WorldNotOpenedError} `openPage()` hasn't resolved yet. */
  get page(): Page {
    const page = pageByWorld.get(this);
    if (!page) {
      throw new WorldNotOpenedError("page");
    }
    return page;
  }

  /** The APIRequestContext this pickle's own `await this.openRequest()`
   * opened.
   * @throws {WorldNotOpenedError} `openRequest()` hasn't resolved yet. */
  get request(): APIRequestContext {
    const request = requestByWorld.get(this);
    if (!request) {
      throw new WorldNotOpenedError("request");
    }
    return request;
  }

  /** Opens (or, called again this pickle, reuses) the shared ctx's
   * Playwright Page. Delegates straight to `ctx.page()` — same lazy launch,
   * same memoization, same evidence collection — nothing World-specific
   * about the browser itself. */
  async openPage(): Promise<Page> {
    const ctx = runtimeByWorld.get(this);
    if (!ctx) {
      // Unreachable: every World this module constructs goes through
      // instantiateWorldForPickle below, which always attaches one.
      throw new Error("internal: this World has no attached runtime context");
    }
    const page = await ctx.page();
    pageByWorld.set(this, page);
    return page;
  }

  /** Same as `openPage()`, for `ctx.request()`. */
  async openRequest(): Promise<APIRequestContext> {
    const ctx = runtimeByWorld.get(this);
    if (!ctx) {
      // Unreachable, same as openPage() above.
      throw new Error("internal: this World has no attached runtime context");
    }
    const request = await ctx.request();
    requestByWorld.set(this, request);
    return request;
  }
}

let registeredConstructor: WorldConstructor | undefined;

/**
 * Registers the World subclass compat step/hook functions run against for
 * the rest of this discovery/execution run — cucumber-js's own semantics:
 * not attributed to any file (discovery has no per-file meaning for "which
 * World is current"), and a second call simply replaces the first —
 * last-wins, no warning, same as cucumber-js itself.
 */
export function setWorldConstructor(ctor: WorldConstructor): void {
  registeredConstructor = ctor;
}

/** What `instantiateWorldForPickle` hands back: the constructed World a
 * compat step/hook runs against, plus the instrumentation handle
 * src/run/run-scenario.ts calls at each step boundary (`beginStep()`) and
 * reads (`snapshot()`) to build that step's receipt's `world` field. Two
 * separate values rather than one augmented object: the instrumentation
 * handle is executor-only, the same
 * "a step cannot see or reset its own observation" rule create-context.ts's
 * header documents for `observed`/`used` — nothing about `World` itself
 * exposes it. */
export interface InstantiatedWorld {
  readonly world: World;
  readonly instrumentation: WorldInstrumentationHandle;
}

/**
 * Constructs this pickle's own World (base `World`, or whatever
 * `setWorldConstructor` last registered), attaches `ctx` as the runtime
 * bridge `openPage()`/`openRequest()` read from, and wraps the fresh
 * instance for measurement + optional declared-key validation (a throwaway
 * prototype measured this own-data-defineProperty mechanism), applied right
 * here, before any hook or step ever sees this instance. Called exactly
 * once per pickle (one World per pickle, sharing that pickle's own ctx) by
 * src/run/run-scenario.ts, through the reference
 * src/discover/discover-steps.ts captured via its own scoped tsx import —
 * see this file's header for why that indirection matters.
 *
 * @param declaredWorldSchemas This run's `defineWorld` registration (src/
 * compat/define-world.ts), already resolved by discovery — this function
 * never reads that module's buffer itself, so it does not care which of
 * this run's step files (if any) called `defineWorld`, only what the result
 * was.
 * @param declaredCollector This pickle's own declared collector
 * (src/compat/declared.ts) — the same instance src/run/run-scenario.ts
 * also points the allure-js runtime shim's "active
 * collector" pointer at; passed directly here (not read back through that
 * pointer) for the module-identity reason this file's own header explains.
 */
export function instantiateWorldForPickle(
  ctx: StepContext,
  declaredWorldSchemas: Readonly<Record<string, z.ZodTypeAny>>,
  declaredCollector: DeclaredCollector,
): InstantiatedWorld {
  const Ctor = registeredConstructor ?? World;
  const params: WorldConstructorParams = {
    attach(data, mediaType) {
      declaredCollector.recordAttachment(
        "attachment",
        toAttachmentBuffer(data),
        extensionForMediaType(mediaType ?? "text/plain"),
      );
    },
    log(text) {
      declaredCollector.recordLog(text);
    },
    link(url, text) {
      declaredCollector.recordLinks([{ url, name: text }]);
    },
    parameters: {},
  };
  const instance = new Ctor(params);
  runtimeByWorld.set(instance, ctx);
  const instrumentation = instrumentWorld(instance, declaredWorldSchemas);
  return { world: instance, instrumentation };
}
