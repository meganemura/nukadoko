import type { APIRequestContext, Page } from "playwright";
import type { z } from "zod";
import type { StepContext } from "../context.js";
import { WorldNotOpenedError } from "./errors.js";
import { instrumentWorld, type WorldInstrumentationHandle } from "./world-instrumentation.js";

// Responsibility: cucumber-js's own World shape (proto-typed-world findings,
// question 5 — a single-argument constructor receiving `{ attach, log,
// link, parameters }`, all four just own writable data properties at run
// time despite being typed readonly upstream) plus the harness's own
// two-tier page/request access (m2b-compat-execution task spec, decision 1,
// lead-arbitrated):
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
// `attach`/`log`/`link` are *received, not dropped*: this slice has no
// reader for them yet (that is M2's slice D, the allure runtime shim's
// `declared` bucket), but silently discarding what glue code passes them
// would make D's later behavior look like new behavior materializing out of
// nowhere, rather than a bucket learning to read what was already being
// held. `instantiateWorldForPickle` below is what actually builds these
// three functions; this class only ever stores whatever it is handed.
//
// Module-identity note (same shape as src/compat/registry.ts's own header):
// `runtimeByWorld` (the ctx bridge) and `heldByWorld` (the attach/log/link
// buckets) are keyed by the constructed instance, in WeakMaps private to
// *this* module — so whichever module instance a user's `class MyWorld
// extends World` resolved "nukadoko/compat" to (src/discover/discover-
// steps.ts's scoped tsx import during discovery) is the exact instance
// whose `openPage()`/`get page()` methods close over the matching WeakMap.
// src/discover/discover-steps.ts captures `instantiateWorldForPickle` itself
// through that same scoped import, rather than a plain top-level one, for
// exactly this reason — see that file's own header for the mechanism this
// mirrors.

export interface WorldConstructorParams {
  readonly attach: (data: unknown, mediaType?: string) => void;
  readonly log: (text: string) => void;
  readonly link: (url: string, text?: string) => void;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export type WorldConstructor = new (params: WorldConstructorParams) => World;

const runtimeByWorld = new WeakMap<World, StepContext>();
const pageByWorld = new WeakMap<World, Page>();
const requestByWorld = new WeakMap<World, APIRequestContext>();

/** Held for M2's slice D (allure's `declared` bucket); unread by anything in
 * this slice — see this file's own header. */
interface HeldDeclarations {
  readonly attachments: { data: unknown; mediaType: string | undefined }[];
  readonly logs: string[];
  readonly links: { url: string; text: string | undefined }[];
}
const heldByWorld = new WeakMap<World, HeldDeclarations>();

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
      // Unreachable: every World this slice constructs goes through
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
 * the rest of this discovery/execution run — cucumber-js's own semantics
 * (m2-design.md section 2): not attributed to any file (discovery has no
 * per-file meaning for "which World is current"), and a second call simply
 * replaces the first — last-wins, no warning, same as cucumber-js itself.
 */
export function setWorldConstructor(ctor: WorldConstructor): void {
  registeredConstructor = ctor;
}

/** What `instantiateWorldForPickle` hands back: the constructed World a
 * compat step/hook runs against, plus the instrumentation handle
 * src/run/run-scenario.ts calls at each step boundary (`beginStep()`) and
 * reads (`snapshot()`) to build that step's receipt's `world` field (m2c-
 * typed-world task spec, item 3). Two separate values rather than one
 * augmented object: the instrumentation handle is executor-only, the same
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
 * instance for measurement + optional declared-key validation (m2c-typed-
 * world task spec, items 1-2; proto-typed-world/findings.md's verified
 * own-data-defineProperty mechanism), applied right here, before any hook or
 * step ever sees this instance ("instantiateWorldForPickle が生成直後の
 * World に適用" — this task's spec, item 1). Called exactly once per
 * pickle (m2b-compat-execution task spec, item 4: "1 pickle = 1 World = 1
 * ctx") by src/run/run-scenario.ts, through the reference
 * src/discover/discover-steps.ts captured via its own scoped tsx import —
 * see this file's header for why that indirection matters.
 *
 * @param declaredWorldSchemas This run's `defineWorld` registration (src/
 * compat/define-world.ts), already resolved by discovery — this function
 * never reads that module's buffer itself, so it does not care which of
 * this run's step files (if any) called `defineWorld`, only what the result
 * was.
 */
export function instantiateWorldForPickle(
  ctx: StepContext,
  declaredWorldSchemas: Readonly<Record<string, z.ZodTypeAny>>,
): InstantiatedWorld {
  const Ctor = registeredConstructor ?? World;
  const held: HeldDeclarations = { attachments: [], logs: [], links: [] };
  const params: WorldConstructorParams = {
    attach(data, mediaType) {
      held.attachments.push({ data, mediaType });
    },
    log(text) {
      held.logs.push(text);
    },
    link(url, text) {
      held.links.push({ url, text });
    },
    parameters: {},
  };
  const instance = new Ctor(params);
  runtimeByWorld.set(instance, ctx);
  heldByWorld.set(instance, held);
  const instrumentation = instrumentWorld(instance, declaredWorldSchemas);
  return { world: instance, instrumentation };
}
