// Responsibility: a fake "vscode" module for tests/e2e/*.test.ts, standing
// in for the real one, which resolves only inside an actual extension host
// and is not installed under node_modules at all (src/extension.ts's own
// header explains why the pure layers avoid it; this file exists because
// the e2e tests need the bundled dist/extension.js -- src/extension.ts
// itself -- to run outside that host). Covers only the surface
// src/extension.ts's activate() and its diagnostics command actually touch:
// registering providers/commands/watchers, one diagnostic collection, two
// user-facing messages, and the handful of value classes those calls
// construct (Uri, Position, Range, Location, CompletionItem, Diagnostic,
// DiagnosticSeverity). Not a general vscode mock -- a new API surface
// src/extension.ts starts using belongs here too, on purpose, so this
// file's own shape stays proof that "what the e2e tests exercise" and
// "what activate() actually calls" never quietly drift apart.
import Module, { createRequire } from "node:module";

export interface FakeUri {
  readonly fsPath: string;
  toString(): string;
}

export interface FakeWorkspaceFolder {
  readonly uri: FakeUri;
}

export interface FakeDiagnostic {
  readonly message: string;
  readonly severity: number;
  code: string | number | undefined;
}

export class FakeDiagnosticCollection {
  // Keyed by fsPath, not a FakeUri instance: the extension and a test each
  // build their own Uri.file(...) call for the "same" path, and those are
  // two different objects, so a Map keyed on object identity would never
  // let a test find what the extension actually set.
  readonly entries = new Map<string, readonly FakeDiagnostic[]>();
  set(uri: FakeUri, diagnostics: readonly FakeDiagnostic[]): void {
    this.entries.set(uri.fsPath, diagnostics);
  }
  clear(): void {
    this.entries.clear();
  }
  dispose(): void {}
}

export interface DefinitionProviderLike {
  provideDefinition(document: unknown, position: unknown): unknown;
}

export interface CompletionProviderLike {
  provideCompletionItems(document: unknown, position: unknown): unknown;
}

export interface VscodeStub {
  /** What Module._load hands back for `require("vscode")` once
   * {@link installVscodeModule} is active -- not `readonly`: createVscodeStub
   * has to hand callers a `stub` object before the module object that closes
   * over it exists, then fill this field in once it does. */
  module: unknown;
  /** fsPath -> file content, read by the fake workspace.fs.readFile /
   * listed by the fake workspace.findFiles. A test populates this directly
   * rather than writing real files -- extractStepDeclarations only ever
   * parses text, so a real file on disk proves nothing extra. */
  readonly files: Map<string, string>;
  workspaceFolders: FakeWorkspaceFolder[] | undefined;
  definitionProvider?: DefinitionProviderLike;
  completionProvider?: CompletionProviderLike;
  readonly commands: Map<string, (...args: unknown[]) => unknown>;
  diagnosticCollection?: FakeDiagnosticCollection;
  readonly errorMessages: string[];
  readonly warningMessages: string[];
}

export function createVscodeStub(): VscodeStub {
  const files = new Map<string, string>();
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const errorMessages: string[] = [];
  const warningMessages: string[] = [];

  const stub: VscodeStub = {
    module: undefined,
    files,
    workspaceFolders: undefined,
    commands,
    errorMessages,
    warningMessages,
  };

  class Uri implements FakeUri {
    private constructor(public readonly fsPath: string) {}
    static file(fsPath: string): Uri {
      return new Uri(fsPath);
    }
    toString(): string {
      return `file://${this.fsPath}`;
    }
  }

  class Position {
    constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }

  class Range {
    constructor(
      public readonly start: Position,
      public readonly end: Position,
    ) {}
  }

  class Location {
    constructor(
      public readonly uri: Uri,
      public readonly rangeOrPosition: Range | Position,
    ) {}
  }

  class CompletionItem {
    detail: string | undefined;
    constructor(public readonly label: string) {}
  }

  class Diagnostic implements FakeDiagnostic {
    code: string | number | undefined;
    constructor(
      public readonly range: Range,
      public readonly message: string,
      public readonly severity: number = 0,
    ) {}
  }

  const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

  const vscodeModule = {
    workspace: {
      get workspaceFolders(): FakeWorkspaceFolder[] | undefined {
        return stub.workspaceFolders;
      },
      async findFiles(): Promise<Uri[]> {
        return Array.from(files.keys()).map((fsPath) => Uri.file(fsPath));
      },
      fs: {
        async readFile(uri: Uri): Promise<Buffer> {
          const content = files.get(uri.fsPath);
          if (content === undefined) {
            throw new Error(`vscode-stub: no such fake file: ${uri.fsPath}`);
          }
          return Buffer.from(content, "utf8");
        },
      },
      createFileSystemWatcher() {
        return {
          onDidChange: () => ({ dispose(): void {} }),
          onDidCreate: () => ({ dispose(): void {} }),
          onDidDelete: () => ({ dispose(): void {} }),
          dispose(): void {},
        };
      },
    },
    languages: {
      registerDefinitionProvider(_selector: unknown, provider: DefinitionProviderLike) {
        stub.definitionProvider = provider;
        return { dispose(): void {} };
      },
      registerCompletionItemProvider(_selector: unknown, provider: CompletionProviderLike) {
        stub.completionProvider = provider;
        return { dispose(): void {} };
      },
      createDiagnosticCollection(_name: string): FakeDiagnosticCollection {
        const collection = new FakeDiagnosticCollection();
        stub.diagnosticCollection = collection;
        return collection;
      },
    },
    commands: {
      registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
        commands.set(id, handler);
        return { dispose(): void {} };
      },
    },
    window: {
      showErrorMessage(message: string): Promise<undefined> {
        errorMessages.push(message);
        return Promise.resolve(undefined);
      },
      showWarningMessage(message: string): Promise<undefined> {
        warningMessages.push(message);
        return Promise.resolve(undefined);
      },
    },
    Uri,
    Position,
    Range,
    Location,
    CompletionItem,
    Diagnostic,
    DiagnosticSeverity,
  };

  stub.module = vscodeModule;
  return stub;
}

type NodeModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
interface ModuleWithLoad {
  _load: NodeModuleLoad;
}

/**
 * Makes every `require("vscode")` resolve to `stub.module`, by intercepting
 * Node's own module loader the way mocking libraries such as proxyquire do
 * -- the same technique this package's own tree-sitter-runtime.ts comment
 * documents esbuild's `require()`-vs-`import` condition resolution around,
 * applied here to substitute the whole module rather than pick a build of
 * it. Returns a restore function; a caller that does not call it leaks the
 * interception into every test that runs after it in the same worker.
 */
export function installVscodeModule(stub: VscodeStub): () => void {
  const moduleWithLoad = Module as unknown as ModuleWithLoad;
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function patchedLoad(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    if (request === "vscode") {
      return stub.module;
    }
    return originalLoad.call(this as ModuleWithLoad, request, parent, isMain);
  };
  return () => {
    moduleWithLoad._load = originalLoad;
  };
}

export interface ExtensionModule {
  activate(context: { subscriptions: { dispose(): void }[] }): void;
  deactivate(): void;
}

/**
 * Requires the bundled `dist/extension.js` fresh, clearing Node's own
 * require cache first: a stale cache entry would still hold the
 * `require("vscode")` result an *earlier* stub returned (module-level code
 * runs once, on first require), so a test that installs a new stub and
 * expects `activate()` to use it needs a fresh top-level evaluation, not
 * the cached one.
 */
export function requireFreshExtension(distExtensionPath: string): ExtensionModule {
  const require = createRequire(import.meta.url);
  const resolved = require.resolve(distExtensionPath);
  delete require.cache[resolved];
  return require(resolved) as ExtensionModule;
}
