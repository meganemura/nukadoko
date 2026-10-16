// Responsibility: prove the bundled extension indexes the same step files
// `nuka` loads (`.ts`, `.mts`, `.js`, `.mjs`, never a `.d.ts`, `.d.mts`,
// `.tsx`, or `.cjs`, and nothing under node_modules), by
// asking for completions in a fake workspace that holds one step per kind.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVscodeStub, installVscodeModule, requireFreshExtension, type VscodeStub } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const distExtensionPath = path.join(here, "..", "..", "dist", "extension.js");

function compatStep(pattern: string): string {
  return ['import { Given } from "nukadoko/compat";', "", `Given(${JSON.stringify(pattern)}, () => {});`, ""].join(
    "\n",
  );
}

describe("dist/extension.js: the step files it indexes", () => {
  let stub: VscodeStub;
  let restoreModuleLoad: () => void;

  beforeAll(() => {
    stub = createVscodeStub();
    const steps = "/fake-workspace/features/steps";
    stub.files.set(`${steps}/plain.ts`, compatStep("a ts step"));
    stub.files.set(`${steps}/module.mts`, compatStep("an mts step"));
    stub.files.set(`${steps}/script.js`, compatStep("a js step"));
    stub.files.set(`${steps}/module.mjs`, compatStep("an mjs step"));
    stub.files.set(`${steps}/types.d.ts`, compatStep("a d.ts step"));
    stub.files.set(`${steps}/types.d.mts`, compatStep("a d.mts step"));
    stub.files.set(`${steps}/view.tsx`, compatStep("a tsx step"));
    stub.files.set(`${steps}/legacy.cjs`, compatStep("a cjs step"));
    stub.files.set("/fake-workspace/node_modules/dep/steps.ts", compatStep("a node_modules step"));
    restoreModuleLoad = installVscodeModule(stub);
    requireFreshExtension(distExtensionPath).activate({ subscriptions: [] });
  });

  afterAll(() => {
    restoreModuleLoad();
  });

  it("offers the steps of .ts, .mts, .js, and .mjs files only", async () => {
    const completions = (await stub.completionProvider?.provideCompletionItems(undefined, undefined)) as
      | { label: string }[]
      | undefined;

    expect(completions?.map((item) => item.label).sort()).toEqual(
      ["a js step", "a ts step", "an mjs step", "an mts step"].sort(),
    );
  });
});

describe("dist/extension.js: the file events that rebuild the index", () => {
  let stub: VscodeStub;
  let restoreModuleLoad: () => void;

  beforeAll(() => {
    stub = createVscodeStub();
    stub.workspaceFolders = [{ uri: { fsPath: "/work/build/app", toString: () => "file:///work/build/app" } }];
    restoreModuleLoad = installVscodeModule(stub);
    requireFreshExtension(distExtensionPath).activate({ subscriptions: [] });
  });

  afterAll(() => {
    restoreModuleLoad();
  });

  it("ignores a write under an excluded directory and rebuilds for a step file", () => {
    expect(stub.findFilesCalls).toBe(1);

    stub.fireFileEvent("change", "/work/build/app/node_modules/dep/index.js");
    stub.fireFileEvent("create", "/work/build/app/dist/extension.js");
    stub.fireFileEvent("delete", "/work/build/app/packages/web/node_modules/x/a.mjs");
    expect(stub.findFilesCalls).toBe(1);

    stub.fireFileEvent("change", "/work/build/app/features/steps/todo.ts");
    expect(stub.findFilesCalls).toBe(2);
  });
});
