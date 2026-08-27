// Responsibility: prove that activate() alone -- no command run, no `nuka`
// spawned -- reflects a step declaration extractStepDeclarations could not
// statically resolve (a computed pattern) as a diagnostic on its own
// collection, separate from the `nukadoko.check` command's own. Mirrors
// tests/e2e/zero-execution.test.ts's own shape (dist/extension.js, driven
// through the fake "vscode" module, never the un-bundled src/extension.ts)
// but for this feature's own observable: a DiagnosticCollection's contents,
// not a definition/completion result.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createVscodeStub,
  installVscodeModule,
  requireFreshExtension,
  type FakeDiagnosticCollection,
  type VscodeStub,
} from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const distExtensionPath = path.join(here, "..", "..", "dist", "extension.js");

const CHECK_COMMAND = "nukadoko.check";
const CHECK_COLLECTION_NAME = "nukadoko";
const STATIC_COLLECTION_NAME = "nukadoko-static";
const FIXTURE_PATH = "/fake-workspace/features/steps/computed-pattern.ts";

interface VscodeLanguagesLike {
  createDiagnosticCollection(name: string): FakeDiagnosticCollection;
}

interface VscodeModuleLike {
  readonly languages: VscodeLanguagesLike;
}

describe("nukadoko-static: activate() alone reflects an unresolvable pattern, without running `nuka`", () => {
  let stub: VscodeStub;
  let restoreModuleLoad: () => void;
  const collectionsByName = new Map<string, FakeDiagnosticCollection>();

  beforeAll(async () => {
    stub = createVscodeStub();
    stub.files.set(
      FIXTURE_PATH,
      [
        'import { defineStep } from "nukadoko";',
        'import { z } from "zod";',
        "",
        // Same shape as tests/fixtures/typed-computed-pattern-variable.ts:
        // `pattern` is a variable reference, not a literal, so reading it
        // would require running this file -- exactly what buildStepIndex
        // must never do.
        'const dynamicPattern = "a {x:int} widgets";',
        "",
        "export default defineStep({",
        "  pattern: dynamicPattern,",
        '  description: "pattern is a variable, not a literal",',
        "  args: z.object({ x: z.number() }),",
        "  returns: z.object({ x: z.number() }),",
        "  mutates: false,",
        "  run(_fixtures, args) { return args; },",
        "});",
        "",
      ].join("\n"),
    );

    restoreModuleLoad = installVscodeModule(stub);

    // vscode-stub.ts's own createDiagnosticCollection keeps only the most
    // recently created collection (stub.diagnosticCollection, a single
    // field) -- enough for tests/e2e/diagnostics-command.test.ts, which
    // only ever needs the `nukadoko` one, but not enough for this test,
    // which needs both of this extension's two collections at once.
    // Wrapped here, in this file only, so the shared stub stays untouched.
    const languages = (stub.module as VscodeModuleLike).languages;
    const originalCreate = languages.createDiagnosticCollection.bind(languages);
    languages.createDiagnosticCollection = (name: string) => {
      const collection = originalCreate(name);
      collectionsByName.set(name, collection);
      return collection;
    };

    const extension = requireFreshExtension(distExtensionPath);
    extension.activate({ subscriptions: [] });

    // Same attach-order reasoning tests/e2e/zero-execution.test.ts's own
    // provider calls rely on: activate() attaches its own diagnostics
    // refresh to indexPromise before this call attaches its own `await
    // indexPromise` continuation, so by the time this resolves, the
    // refresh has already run.
    await stub.completionProvider?.provideCompletionItems(undefined, undefined);
  });

  afterAll(() => {
    restoreModuleLoad();
  });

  it("never spawns `nuka`: the check command is registered but was never invoked", () => {
    expect(stub.commands.has(CHECK_COMMAND)).toBe(true);
    expect(stub.errorMessages).toEqual([]);
    expect(collectionsByName.get(CHECK_COLLECTION_NAME)?.entries.size ?? 0).toBe(0);
  });

  it("reflects the computed-pattern declaration as a warning on the nukadoko-static collection", () => {
    const staticCollection = collectionsByName.get(STATIC_COLLECTION_NAME);
    expect(staticCollection).toBeDefined();

    const diagnosticsForFixture = staticCollection?.entries.get(FIXTURE_PATH);
    expect(diagnosticsForFixture).toBeDefined();
    expect(diagnosticsForFixture?.length).toBeGreaterThanOrEqual(1);
    expect(diagnosticsForFixture?.[0]).toEqual(
      expect.objectContaining({
        code: "nukadoko-static-unresolved",
        severity: 1, // DiagnosticSeverity.Warning
        message: expect.stringContaining("statically unresolvable"),
      }),
    );
  });
});
