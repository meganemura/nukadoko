// Responsibility: prove the bundled extension keeps indexing when one step
// file cannot be read, says which file, and reports an index that fails as
// a whole instead of leaving an unhandled rejection.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createVscodeStub,
  installVscodeModule,
  requireFreshExtension,
  type FakeDiagnosticCollection,
  type VscodeStub,
} from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const distExtensionPath = path.join(here, "..", "..", "dist", "extension.js");

const READABLE_PATH = "/fake-workspace/features/steps/readable.ts";
const LOCKED_PATH = "/fake-workspace/features/steps/locked.ts";

interface WorkspaceLike {
  findFiles(include: string, exclude?: string): Promise<unknown[]>;
  readonly fs: { readFile(uri: { fsPath: string }): Promise<Buffer> };
}

function workspaceOf(stub: VscodeStub): WorkspaceLike {
  return (stub.module as { workspace: WorkspaceLike }).workspace;
}

function collectionsOf(stub: VscodeStub): Map<string, FakeDiagnosticCollection> {
  const byName = new Map<string, FakeDiagnosticCollection>();
  const languages = (stub.module as { languages: { createDiagnosticCollection(name: string): FakeDiagnosticCollection } })
    .languages;
  const originalCreate = languages.createDiagnosticCollection.bind(languages);
  languages.createDiagnosticCollection = (name: string) => {
    const collection = originalCreate(name);
    byName.set(name, collection);
    return collection;
  };
  return byName;
}

async function completionLabels(stub: VscodeStub): Promise<string[]> {
  const items = (await stub.completionProvider?.provideCompletionItems(undefined, undefined)) as { label: string }[];
  return items.map((item) => item.label);
}

describe("dist/extension.js: a step index that cannot read everything", () => {
  let restoreModuleLoad: (() => void) | undefined;

  afterEach(() => {
    restoreModuleLoad?.();
  });

  it("indexes the readable file and warns on the one it cannot read", async () => {
    const stub = createVscodeStub();
    stub.files.set(
      READABLE_PATH,
      ['import { Given } from "nukadoko/compat";', "", 'Given("a readable step", () => {});', ""].join("\n"),
    );
    stub.files.set(LOCKED_PATH, "");
    const workspace = workspaceOf(stub);
    const originalReadFile = workspace.fs.readFile.bind(workspace.fs);
    workspace.fs.readFile = async (uri) => {
      if (uri.fsPath === LOCKED_PATH) {
        throw new Error("EACCES: permission denied");
      }
      return originalReadFile(uri);
    };
    const collections = collectionsOf(stub);
    restoreModuleLoad = installVscodeModule(stub);
    requireFreshExtension(distExtensionPath).activate({ subscriptions: [] });

    expect(await completionLabels(stub)).toEqual(["a readable step"]);
    expect(collections.get("nukadoko-static")?.entries.get(LOCKED_PATH)).toEqual([
      expect.objectContaining({
        code: "nukadoko-static-unreadable",
        severity: 1,
        message: "nukadoko could not read this file to index its steps: EACCES: permission denied",
      }),
    ]);
  });

  it("shows an error when the workspace cannot be listed", async () => {
    const stub = createVscodeStub();
    workspaceOf(stub).findFiles = async () => {
      throw new Error("search service unavailable");
    };
    restoreModuleLoad = installVscodeModule(stub);
    requireFreshExtension(distExtensionPath).activate({ subscriptions: [] });

    await expect(completionLabels(stub)).rejects.toThrow("search service unavailable");
    expect(stub.errorMessages).toEqual(["nukadoko: indexing step files failed: search service unavailable"]);
  });
});
