import { z } from "zod";
import { defineWorld, setWorldConstructor } from "../../nukadoko-compat-shim.js";

// This run's own `defineWorld` registration (m2c-typed-world task spec, item
// 2) — `listing` is legitimately absent until first write
// (`.optional()`), the case proto-typed-world/findings.md's "hole 2" is
// about: a declared-but-not-yet-present key must still validate its first
// write, not skip validation because there was nothing to overwrite yet.
const worldSchemas = {
  listing: z.object({ id: z.string() }).optional(),
};

// `defineWorld`'s own TS typing attempt (m2c-typed-world task spec, item 4,
// src/compat/define-world.ts's own header): extending its return value
// carries `listing`'s inferred type onto `this` in every compat glue
// function typed `this: CustomWorld` below — no interface written by hand.
export class CustomWorld extends defineWorld(worldSchemas) {
  // An ordinary (undeclared) bag field — measured like any other own data
  // property, never zod-validated (this task's spec, item 1: "宣言はオプ
  // ション").
  visits = 0;

  // proto-typed-world/findings.md's central claim: a `#private` field stays
  // reachable through a method exactly as if this instrumentation didn't
  // exist, because the wrap mechanism never wraps `this` itself in a Proxy
  // — only own *data* properties are replaced with accessors, directly on
  // the real instance.
  #secret = 42;

  revealSecret(): number {
    return this.#secret;
  }
}

setWorldConstructor(CustomWorld);
