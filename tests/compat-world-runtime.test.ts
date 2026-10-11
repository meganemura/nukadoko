import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { APIRequestContext, Page } from "playwright";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { createDeclaredCollector } from "../src/compat/declared.js";
import { defineWorld, drainWorldSchemaRegistrations } from "../src/compat/define-world.js";
import {
  CompatTimeoutError,
  ReservedWorldKeyDeclaredError,
  ReservedWorldKeyWriteError,
  UnsupportedTagExpressionError,
  WorldNotOpenedError,
  WorldWriteValidationError,
  isWorldWriteValidationError,
} from "../src/compat/errors.js";
import { RESERVED_WORLD_KEYS, instrumentWorld } from "../src/compat/world-instrumentation.js";
import {
  World,
  instantiateWorldForPickle,
  setWorldConstructor,
  type WorldConstructorParams,
} from "../src/compat/world.js";
import type { StepContext } from "../src/step/context.js";

// Responsibility: direct unit coverage for compat's own runtime surface
// (World, its instrumentation wrap, defineWorld's registration buffer, and
// the error classes all four throw). tests/compat-world.test.ts and
// tests/compat-typed-world.test.ts already exercise the same mechanism end
// to end through a compat glue file, but that file is loaded via
// discovery's own scoped tsx import (world.ts's own header explains why) —
// a separate module realm from this test file's plain top-level import.
// Testing the exported functions directly here, through that plain
// realm, reaches branches an end-to-end run's own realm boundary leaves
// dark: the request-side unopened getter, the own-method/own-accessor skip
// in reconcile(), the registration buffer's own accumulate/drain contract,
// and every error class's own message/field construction.

function stubParams(): WorldConstructorParams {
  return { attach: () => {}, log: () => {}, link: () => {}, parameters: {} };
}

function stubCtx(): StepContext {
  // Never called in these tests — only its identity is stored
  // (world.ts's own `runtimeByWorld`), since what's under test here is the
  // unopened-getter branch, not openPage()/openRequest() themselves.
  return {} as StepContext;
}

describe("World (src/compat/world.ts): construction and unopened getters", () => {
  it("holds attach/log/link/parameters exactly as constructed", () => {
    const params = stubParams();
    const world = new World(params);
    expect(world.attach).toBe(params.attach);
    expect(world.log).toBe(params.log);
    expect(world.link).toBe(params.link);
    expect(world.parameters).toBe(params.parameters);
  });

  it("World.page throws WorldNotOpenedError before openPage() resolves", () => {
    const world = new World(stubParams());
    try {
      void world.page;
      expect.unreachable("world.page should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorldNotOpenedError);
      expect((error as WorldNotOpenedError).member).toBe("page");
      expect((error as Error).message).toContain("openPage()");
      expect((error as Error).message).toContain("await this.openPage()");
    }
  });

  it("World.request throws WorldNotOpenedError before openRequest() resolves", () => {
    const world = new World(stubParams());
    try {
      void world.request;
      expect.unreachable("world.request should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorldNotOpenedError);
      expect((error as WorldNotOpenedError).member).toBe("request");
      expect((error as Error).message).toContain("openRequest()");
      expect((error as Error).message).toContain("await this.openRequest()");
    }
  });

  it("a World subclass can assign this.page and this.request", () => {
    class CustomWorld extends World {}
    const world = new CustomWorld(stubParams());
    const page = { kind: "caller-page" } as unknown as Page;
    const request = { kind: "caller-request" } as unknown as APIRequestContext;

    world.page = page;
    world.request = request;

    expect(world.page).toBe(page);
    expect(world.request).toBe(request);
  });

  it("an assignment wins over the page openPage() stored, and it is not a measured world key", async () => {
    const opened = { kind: "opened-page" } as unknown as Page;
    const assigned = { kind: "assigned-page" } as unknown as Page;
    const openedRequest = { kind: "opened-request" } as unknown as APIRequestContext;
    const assignedRequest = { kind: "assigned-request" } as unknown as APIRequestContext;
    const { world, instrumentation } = instantiateWorldForPickle(
      {
        page: async () => opened,
        request: async () => openedRequest,
      } as StepContext,
      {},
      createDeclaredCollector(),
    );
    instrumentation.beginStep();

    expect(await world.openPage()).toBe(opened);
    expect(await world.openRequest()).toBe(openedRequest);
    expect(world.page).toBe(opened);
    expect(world.request).toBe(openedRequest);

    world.page = assigned;
    world.request = assignedRequest;

    expect(world.page).toBe(assigned);
    expect(world.request).toBe(assignedRequest);
    expect(Object.getOwnPropertyDescriptor(world, "page")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(world, "request")).toBeUndefined();
    expect(instrumentation.snapshot()).toEqual({ reads: [], writes: [] });
  });
});

describe("instantiateWorldForPickle (src/compat/world.ts): default World, attach/log/link wiring", () => {
  it("constructs the base World when setWorldConstructor was never called for this instance", () => {
    // Runs first in file order, before any setWorldConstructor call below,
    // so registeredConstructor is still unset — the `?? World` fallback
    // branch this asserts on would otherwise never run.
    const collector = createDeclaredCollector();
    const { world, instrumentation } = instantiateWorldForPickle(stubCtx(), {}, collector, {});
    expect(world).toBeInstanceOf(World);
    expect(world.constructor).toBe(World);
    instrumentation.beginStep();
    expect(instrumentation.snapshot()).toEqual({ reads: [], writes: [] });
  });

  it("passes the supplied parameters object through by identity", () => {
    const parameters = { baseUrl: "http://example.test", retries: 2 };
    const { world } = instantiateWorldForPickle(stubCtx(), {}, createDeclaredCollector(), parameters);
    expect(world.parameters).toBe(parameters);
  });

  it("attach() writes a file and records it once the collector has a directory; log()/link() record regardless", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-world-unit-"));
    try {
      const collector = createDeclaredCollector();
      const { world } = instantiateWorldForPickle(stubCtx(), {}, collector, {});

      // Before beginStep(): recordAttachment is a documented no-op (no
      // directory to write into yet); log/link still record.
      world.log("early log");
      world.link("https://example.com");
      expect(collector.snapshot()).toEqual({
        links: [{ url: "https://example.com" }],
        logs: ["early log"],
      });

      collector.beginStep(dir);
      world.attach("hello world", "text/plain");
      const snapshot = collector.snapshot();
      expect(snapshot?.attachments).toHaveLength(1);
      const [fileName] = snapshot!.attachments!;
      expect(fileName).toMatch(/\.txt$/);
      expect(readFileSync(path.join(dir, fileName!), "utf8")).toBe("hello world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("instantiateWorldForPickle: cucumber-js attach and link forms", () => {
  function withStep(
    run: (dir: string, world: World, collector: ReturnType<typeof createDeclaredCollector>) => void | Promise<void>,
  ): Promise<void> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-world-forms-"));
    const collector = createDeclaredCollector();
    const { world } = instantiateWorldForPickle(stubCtx(), {}, collector);
    collector.beginStep(dir);
    return Promise.resolve(run(dir, world, collector)).finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it("decodes a base64: media type into that type's bytes", () =>
    withStep((dir, world, collector) => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      world.attach(png.toString("base64"), "base64:image/png");
      const fileName = collector.snapshot()?.attachments?.[0];
      expect({
        fileName,
        bytes: fileName === undefined ? null : readFileSync(path.join(dir, fileName)),
      }).toEqual({ fileName: "attachment.png", bytes: png });
    }));

  it("writes { mediaType, fileName } under the given file name", () =>
    withStep((dir, world, collector) => {
      world.attach(Buffer.from("hello"), {
        mediaType: "text/plain",
        fileName: "greeting.txt",
      });
      const fileName = collector.snapshot()?.attachments?.[0];
      expect({
        fileName,
        text: fileName === undefined ? null : readFileSync(path.join(dir, fileName), "utf8"),
      }).toEqual({ fileName: "greeting.txt", text: "hello" });
    }));

  it("reads a readable stream and returns a promise", () =>
    withStep(async (dir, world, collector) => {
      const pending = world.attach(Readable.from(["hello", " world"]), "text/plain") as unknown;
      if (pending instanceof Promise) {
        await pending;
      }
      const fileName = collector.snapshot()?.attachments?.[0];
      expect({
        returnedPromise: pending instanceof Promise,
        fileName,
        text: fileName === undefined ? null : readFileSync(path.join(dir, fileName), "utf8"),
      }).toEqual({
        returnedPromise: true,
        fileName: "attachment.txt",
        text: "hello world",
      });
    }));

  it("records each link argument as its own URL", () =>
    withStep((_dir, world, collector) => {
      world.link("http://a.example", "http://b.example");
      expect(collector.snapshot()?.links).toEqual([
        { url: "http://a.example" },
        { url: "http://b.example" },
      ]);
    }));

  it("refuses a stream that has no media type", () =>
    withStep((_dir, world) => {
      expect(() => world.attach(Readable.from(["hello"]))).toThrow(
        "Stream attachments must specify a media type",
      );
    }));

  it("decodes every base64: payload back to the original bytes", () =>
    hegel.testAsync(async (tc) => {
      const bytes = Buffer.from(tc.draw(gs.binary({ maxSize: 64 })));
      await withStep((dir, world, collector) => {
        world.attach(bytes.toString("base64"), "base64:image/png");
        const fileName = collector.snapshot()?.attachments?.[0];
        expect(fileName).toBe("attachment.png");
        expect(readFileSync(path.join(dir, fileName!))).toEqual(bytes);
      });
    }));

  it("writes the same stream text for every chunking", () =>
    hegel.testAsync(async (tc) => {
      const chunks = tc.draw(gs.arrays(gs.text({ maxSize: 24 }), { maxSize: 8 }));
      await withStep(async (dir, world, collector) => {
        const pending = world.attach(Readable.from(chunks), "text/plain");
        expect(pending).toBeInstanceOf(Promise);
        await pending;
        const fileName = collector.snapshot()?.attachments?.[0];
        expect(fileName).toBe("attachment.txt");
        expect(readFileSync(path.join(dir, fileName!), "utf8")).toBe(chunks.join(""));
      });
    }));

  it("records a list of link arguments with no names", () =>
    hegel.testAsync(async (tc) => {
      const urls = tc.draw(gs.arrays(gs.urls(), { minSize: 1, maxSize: 4 }));
      await withStep((_dir, world, collector) => {
        world.link(...urls);
        expect(collector.snapshot()?.links).toEqual(urls.map((url) => ({ url })));
      });
    }));
});

describe("instantiateWorldForPickle: setWorldConstructor selects the registered World subclass", () => {
  class CustomWorld extends World {
    visits = 0;
  }

  it("constructs the registered subclass; its own bag fields are measured through the instrumentation handle", () => {
    setWorldConstructor(CustomWorld);
    try {
      const { world, instrumentation } = instantiateWorldForPickle(
        stubCtx(),
        {},
        createDeclaredCollector(),
        {},
      );
      expect(world).toBeInstanceOf(CustomWorld);
      instrumentation.beginStep();
      (world as CustomWorld).visits += 1;
      expect(instrumentation.snapshot()).toEqual({ reads: ["visits"], writes: ["visits"] });
    } finally {
      // `?? World` and an explicit `World` land on the same constructor
      // either way — restores fallback-equivalent state for any later test
      // in this file that expects the default.
      setWorldConstructor(World);
    }
  });
});

describe("defineWorld / drainWorldSchemaRegistrations (src/compat/define-world.ts)", () => {
  it("returns World itself, so a subclass's own prototype chain is unaffected", () => {
    drainWorldSchemaRegistrations(); // clears any leftover from an earlier test in this file
    const Ctor = defineWorld({ x: z.string() });
    expect(Ctor).toBe(World);
  });

  it("buffers one registration per call, in call order, and drain empties the buffer", () => {
    drainWorldSchemaRegistrations();
    const schemasA = { a: z.string() };
    const schemasB = { b: z.number() };
    defineWorld(schemasA);
    defineWorld(schemasB);

    const registrations = drainWorldSchemaRegistrations();
    expect(registrations).toHaveLength(2);
    expect(registrations[0]!.schemas).toBe(schemasA);
    expect(registrations[1]!.schemas).toBe(schemasB);
    // registrationOrder only needs to be strictly increasing across calls:
    // the counter behind it is module-global and never resets, so its
    // absolute value depends on how many defineWorld calls already
    // happened earlier in this module instance's lifetime.
    expect(registrations[1]!.registrationOrder).toBeGreaterThan(
      registrations[0]!.registrationOrder,
    );

    // A second drain, with nothing registered in between, returns empty —
    // the buffer was genuinely emptied, not just read.
    expect(drainWorldSchemaRegistrations()).toEqual([]);
  });

  it("throws ReservedWorldKeyDeclaredError for a reserved key, before ever buffering the registration", () => {
    drainWorldSchemaRegistrations();
    expect(() => defineWorld({ ok: z.string(), attach: z.string() })).toThrow(
      ReservedWorldKeyDeclaredError,
    );
    expect(drainWorldSchemaRegistrations()).toEqual([]);
  });
});

describe("instrumentWorld (src/compat/world-instrumentation.ts): measurement", () => {
  it("records a read and a write, deduplicated, in first-access order, across two fields", () => {
    class Target {
      a = 1;
      b = 2;
    }
    const target = new Target();
    const handle = instrumentWorld(target, {});
    handle.beginStep();

    void target.b; // read b first
    void target.a; // read a
    void target.b; // repeat read of b — must not duplicate
    target.a = 10; // write a

    expect(handle.snapshot()).toEqual({ reads: ["b", "a"], writes: ["a"] });
  });

  it("beginStep() resets the tally each step; a field read again on a later step is recorded again", () => {
    class Target {
      a = 1;
    }
    const target = new Target();
    const handle = instrumentWorld(target, {});

    handle.beginStep();
    void target.a;
    expect(handle.snapshot()).toEqual({ reads: ["a"], writes: [] });

    handle.beginStep();
    expect(handle.snapshot()).toEqual({ reads: [], writes: [] });
    void target.a;
    expect(handle.snapshot()).toEqual({ reads: ["a"], writes: [] });
  });

  it("a key that first appears mid-step is not measured until the next beginStep() (the reconcile one-step-behind limit)", () => {
    const target: Record<string, unknown> = {};
    const handle = instrumentWorld(target, {});
    handle.beginStep();

    target.fresh = "hello"; // plain assignment — no accessor exists yet
    expect(handle.snapshot()).toEqual({ reads: [], writes: [] });

    handle.beginStep(); // reconcile() seeds `fresh` now
    void target.fresh;
    expect(handle.snapshot()).toEqual({ reads: ["fresh"], writes: [] });
  });

  it("a declared-but-absent key is seeded at wrap time, so its first write is validated (the Seeding limit this module documents)", () => {
    const target: Record<string, unknown> = {};
    const handle = instrumentWorld(target, { listing: z.string().optional() });
    handle.beginStep();

    target.listing = "abc";
    expect(handle.snapshot()).toEqual({ reads: [], writes: ["listing"] });
    expect(target.listing).toBe("abc");
  });

  it("an invalid declared write throws WorldWriteValidationError before recording, and does not change the stored value", () => {
    const target: Record<string, unknown> = { listing: "kept" };
    const handle = instrumentWorld(target, { listing: z.string() });
    handle.beginStep();

    expect(() => {
      target.listing = 42;
    }).toThrow(WorldWriteValidationError);
    expect(handle.snapshot()).toEqual({ reads: [], writes: [] });
    expect(target.listing).toBe("kept");
  });

  it("reading a reserved key is not recorded; writing one throws ReservedWorldKeyWriteError and the original value is unaffected", () => {
    const original = () => "original";
    const target: Record<string, unknown> = {
      attach: original,
      log: () => {},
      link: () => {},
      parameters: {},
    };
    const handle = instrumentWorld(target, {});
    handle.beginStep();

    expect(target.attach).toBe(original);
    expect(handle.snapshot()).toEqual({ reads: [], writes: [] });

    expect(() => {
      target.attach = () => "oops";
    }).toThrow(ReservedWorldKeyWriteError);
    expect(target.attach).toBe(original);
  });

  it("RESERVED_WORLD_KEYS names exactly attach/log/link/parameters", () => {
    expect([...RESERVED_WORLD_KEYS].sort()).toEqual(["attach", "link", "log", "parameters"]);
  });

  it("an own function-valued field (an arrow-function class field) is never wrapped: calling it is not measured, and it stays freely reassignable", () => {
    class Target {
      helper = () => "original";
    }
    const target = new Target();
    const handle = instrumentWorld(target, {});
    handle.beginStep();

    target.helper();
    target.helper = () => "replaced";
    expect(handle.snapshot()).toEqual({ reads: [], writes: [] });
    expect(target.helper()).toBe("replaced");
  });

  it("an own accessor already installed at wrap time is never clobbered", () => {
    const target: Record<string, unknown> = {};
    let backing = "initial";
    Object.defineProperty(target, "computed", {
      enumerable: true,
      configurable: true,
      get() {
        return backing;
      },
      set(value: unknown) {
        backing = String(value);
      },
    });
    const handle = instrumentWorld(target, {});
    handle.beginStep();

    expect(target.computed).toBe("initial");
    target.computed = "changed";
    expect(backing).toBe("changed");
    expect(handle.snapshot()).toEqual({ reads: [], writes: [] });
  });
});

describe("compat error classes (src/compat/errors.ts)", () => {
  it("WorldNotOpenedError names the member and the opener to call", () => {
    const pageError = new WorldNotOpenedError("page");
    expect(pageError.name).toBe("WorldNotOpenedError");
    expect(pageError.member).toBe("page");
    expect(pageError.message).toContain("openPage()");

    const requestError = new WorldNotOpenedError("request");
    expect(requestError.member).toBe("request");
    expect(requestError.message).toContain("openRequest()");
  });

  it("UnsupportedTagExpressionError names the unsupported expression", () => {
    const error = new UnsupportedTagExpressionError("@a and @b");
    expect(error.name).toBe("UnsupportedTagExpressionError");
    expect(error.expression).toBe("@a and @b");
    expect(error.message).toContain("@a and @b");
  });

  it("ReservedWorldKeyWriteError names the key and states it cannot be reassigned", () => {
    const error = new ReservedWorldKeyWriteError("attach");
    expect(error.name).toBe("ReservedWorldKeyWriteError");
    expect(error.key).toBe("attach");
    expect(error.message).toContain("attach");
    expect(error.message).toContain("reassigned");
  });

  it("ReservedWorldKeyDeclaredError names the key and states defineWorld cannot declare it", () => {
    const error = new ReservedWorldKeyDeclaredError("parameters");
    expect(error.name).toBe("ReservedWorldKeyDeclaredError");
    expect(error.key).toBe("parameters");
    expect(error.message).toContain("parameters");
    expect(error.message).toContain("defineWorld");
  });

  it("WorldWriteValidationError names the key and carries the formatted issues, and is branded", () => {
    const error = new WorldWriteValidationError("listing", "expected string, received number");
    expect(error.name).toBe("WorldWriteValidationError");
    expect(error.key).toBe("listing");
    expect(error.message).toContain("listing");
    expect(error.message).toContain("expected string, received number");
    expect(isWorldWriteValidationError(error)).toBe(true);
  });

  it("isWorldWriteValidationError is false for anything unbranded", () => {
    expect(isWorldWriteValidationError(new Error("plain"))).toBe(false);
    expect(isWorldWriteValidationError(new ReservedWorldKeyWriteError("attach"))).toBe(false);
    expect(isWorldWriteValidationError(null)).toBe(false);
    expect(isWorldWriteValidationError(undefined)).toBe(false);
    expect(isWorldWriteValidationError("a string")).toBe(false);
    expect(isWorldWriteValidationError({})).toBe(false);
  });

  it("CompatTimeoutError carries its own message and name", () => {
    const error = new CompatTimeoutError("step timed out after 5000ms");
    expect(error.name).toBe("CompatTimeoutError");
    expect(error.message).toBe("step timed out after 5000ms");
  });
});
