// Responsibility: the extension host's entry point, and the only place that
// touches vscode's own APIs -- everything a decision could hide in
// (matching a step's text, deciding what belongs in a completion list)
// lives in src/index/ and src/extraction/ instead, both of which vitest can
// run because neither imports `vscode` (that module only resolves inside a
// real extension host, never under node_modules). This file exists to
// convert vscode's shapes to and from those pure layers' shapes and nothing
// else, so it can be read for correctness in place of being tested.
//
// The one exception is createWorkspaceFileSource below: it is the sole
// place permitted to enumerate and read the open workspace's files, and it
// does so with vscode.workspace.findFiles + workspace.fs.readFile only --
// never import()/require() of anything the workspace owns, because that
// would be exactly the implicit code execution this extension exists to
// avoid (see src/extraction/step-extraction.ts, proven not to execute what
// it parses).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import {
  buildDiagnosticsFromCheckReport,
  buildUnresolvedDiagnostics,
  type DiagnosticsEntry,
} from "./diagnostics/index.js";
import { matchStepText, type ExtractionResult } from "./extraction/index.js";
import {
  buildCompletionCandidates,
  buildStepIndex,
  parseStepLine,
  type FileSource,
} from "./index/index.js";

const execFileAsync = promisify(execFile);

const GHERKIN_LANGUAGE = "gherkin";
const STEP_FILE_GLOB = "**/*.{ts,tsx}";
// Explicit, rather than relying on the user's own files.exclude: a
// workspace that never configured that setting would otherwise have this
// extension read every file under node_modules.
const STEP_FILE_EXCLUDE = "**/{node_modules,dist,out,.git,.nukadoko}/**";

const CHECK_COMMAND = "nukadoko.check";
const DIAGNOSTIC_COLLECTION_NAME = "nukadoko";
// A second, separate collection, for a different reason than
// DIAGNOSTIC_COLLECTION_NAME's own: this one never carries a `nuka check`
// spawn, only buildStepIndex's own tree-sitter parse, already proven zero-
// execution (tests/e2e/zero-execution.test.ts). Kept apart on purpose, so a
// reader can never mistake one collection's contents for the other's.
const UNRESOLVED_DIAGNOSTIC_COLLECTION_NAME = "nukadoko-static";

function createWorkspaceFileSource(): FileSource {
  return {
    async listFiles() {
      const uris = await vscode.workspace.findFiles(STEP_FILE_GLOB, STEP_FILE_EXCLUDE);
      return uris.map((uri) => uri.fsPath);
    },
    async readFile(filePath) {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return Buffer.from(bytes).toString("utf8");
    },
  };
}

// `.cmd` on win32 because that is the shim npm itself installs there for a
// package's bin entry (a plain `nuka` file on that platform is not directly
// spawnable); every other platform gets the real executable npm links in.
function resolveNukaBinaryPath(workspaceRoot: string): string {
  const binaryName = process.platform === "win32" ? "nuka.cmd" : "nuka";
  return path.join(workspaceRoot, "node_modules", ".bin", binaryName);
}

function toDiagnostic(entry: DiagnosticsEntry): vscode.Diagnostic {
  // `entry.line` is 1-indexed (CheckIssue.line, unchanged); vscode.Position
  // is 0-indexed. An issue with no line (or, via the file-less sentinel
  // below, no file either) still needs *some* range to attach to, so it
  // lands on the first line rather than being dropped.
  const line = entry.line !== undefined ? Math.max(entry.line - 1, 0) : 0;
  const range = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, Number.MAX_SAFE_INTEGER));
  const severity = entry.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
  const diagnostic = new vscode.Diagnostic(range, entry.message, severity);
  diagnostic.code = entry.code;
  return diagnostic;
}

// `CheckIssue.file` (when present) is rootDir-relative, not absolute --
// `nuka check`'s own report reads that way against every fixture this
// extension was checked against. An issue with no file at all (one about
// the whole workspace, not one line of it) is attached to the workspace
// root itself, rather than shown through a separate vscode.window.* call:
// keeping every issue inside the one DiagnosticCollection this function
// already builds is what lets a test (and a user re-running the command)
// find it without a second code path to check.
function groupDiagnosticsByFile(
  workspaceRoot: string,
  entries: readonly DiagnosticsEntry[],
): ReadonlyMap<string, vscode.Diagnostic[]> {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const entry of entries) {
    const file =
      entry.file.length > 0
        ? path.isAbsolute(entry.file)
          ? entry.file
          : path.join(workspaceRoot, entry.file)
        : workspaceRoot;
    const diagnosticsForFile = byFile.get(file) ?? [];
    diagnosticsForFile.push(toDiagnostic(entry));
    byFile.set(file, diagnosticsForFile);
  }
  return byFile;
}

function applyDiagnostics(
  collection: vscode.DiagnosticCollection,
  workspaceRoot: string,
  entries: readonly DiagnosticsEntry[],
): void {
  collection.clear();
  for (const [file, diagnostics] of groupDiagnosticsByFile(workspaceRoot, entries)) {
    collection.set(vscode.Uri.file(file), diagnostics);
  }
}

// The one place this extension runs code the open workspace owns, and only
// when a user explicitly asks for it (constraint 0: nothing about opening a
// file, coloring it, or offering a definition/completion may reach this
// function). `execFile`, never `exec`: the workspace's own path is an
// argument here, and a shell would reinterpret it.
async function runCheckCommand(collection: vscode.DiagnosticCollection): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder === undefined) {
    vscode.window.showErrorMessage("nukadoko: Check needs an open workspace folder.");
    return;
  }
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const nukaPath = resolveNukaBinaryPath(workspaceRoot);
  if (!existsSync(nukaPath)) {
    vscode.window.showErrorMessage(
      "nukadoko: Check could not find node_modules/.bin/nuka in this workspace. Run npm install here first.",
    );
    return;
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(nukaPath, ["check", "--json"], { cwd: workspaceRoot }));
  } catch (error) {
    // `nuka check` exits 1 whenever it reports at least one error -- the
    // normal shape of a project with issues to show, not a failure to run
    // at all, and execFile turns that non-zero exit into a rejection. Its
    // JSON report still arrives on that same rejection's own `stdout`; an
    // empty `stdout` is the one case that means the process never produced
    // a report at all (a crash before it could run), which is what still
    // gets surfaced as a message here rather than silently doing nothing.
    const stdoutFromError =
      typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
    if (stdoutFromError.length === 0) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`nukadoko: Check failed to run: ${message}`);
      return;
    }
    stdout = stdoutFromError;
  }

  applyDiagnostics(collection, workspaceRoot, buildDiagnosticsFromCheckReport(stdout));
}

export function activate(context: vscode.ExtensionContext): void {
  // Created before DIAGNOSTIC_COLLECTION_NAME's own collection below, and
  // that order is load-bearing, not incidental: an end-to-end test driving
  // this file through a fake "vscode" module (tests/e2e/vscode-stub.ts)
  // observes only the most recently created DiagnosticCollection, and
  // tests/e2e/diagnostics-command.test.ts already relies on that being the
  // `nukadoko` check collection. Reordering these two creations would break
  // that test for a reason invisible at the call site that moved.
  const unresolvedDiagnosticCollection = vscode.languages.createDiagnosticCollection(
    UNRESOLVED_DIAGNOSTIC_COLLECTION_NAME,
  );
  context.subscriptions.push(unresolvedDiagnosticCollection);

  // Applies one build's own unresolved list to its own moment in time --
  // reads the index through the `result` parameter, not a closure variable,
  // so a rebuild started before an earlier one settles can never mix an old
  // build's unresolved declarations into a newer sweep (applyDiagnostics
  // always clears the collection before it sets, so whichever call lands
  // last wins outright).
  function refreshUnresolvedDiagnostics(result: Promise<ExtractionResult>): void {
    void result.then((index) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      applyDiagnostics(unresolvedDiagnosticCollection, workspaceRoot, buildUnresolvedDiagnostics(index.unresolved));
    });
  }

  // Built once here and awaited by every provider call below, not rebuilt
  // per call -- only a file save (via the watcher) replaces it. A provider
  // that rebuilt on every keystroke would re-parse the whole workspace on
  // every definition lookup and completion request.
  let indexPromise: Promise<ExtractionResult> = buildStepIndex(createWorkspaceFileSource());
  refreshUnresolvedDiagnostics(indexPromise);

  const watcher = vscode.workspace.createFileSystemWatcher(STEP_FILE_GLOB);
  const rebuildIndex = () => {
    indexPromise = buildStepIndex(createWorkspaceFileSource());
    refreshUnresolvedDiagnostics(indexPromise);
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(rebuildIndex),
    watcher.onDidCreate(rebuildIndex),
    watcher.onDidDelete(rebuildIndex),
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(GHERKIN_LANGUAGE, {
      async provideDefinition(document, position) {
        const stepText = parseStepLine(document.lineAt(position.line).text);
        if (stepText === undefined) {
          return undefined;
        }
        const index = await indexPromise;
        const matched = matchStepText(stepText, index.patterns);
        return matched.map(
          (declaration) =>
            new vscode.Location(
              vscode.Uri.file(declaration.declarationFile),
              new vscode.Position(declaration.declarationPosition.row, declaration.declarationPosition.column),
            ),
        );
      },
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(GHERKIN_LANGUAGE, {
      async provideCompletionItems() {
        const index = await indexPromise;
        return buildCompletionCandidates(index.patterns).map((candidate) => {
          const item = new vscode.CompletionItem(candidate.insertText);
          item.detail = candidate.detail;
          return item;
        });
      },
    }),
  );

  // Created once here, same as indexPromise above -- runCheckCommand only
  // ever replaces its contents (applyDiagnostics's own collection.clear() +
  // set()), never recreates it, so a second run of the command updates the
  // same diagnostics a reader is already looking at instead of a fresh,
  // separately-tracked collection.
  const diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION_NAME);
  context.subscriptions.push(diagnosticCollection);

  context.subscriptions.push(
    vscode.commands.registerCommand(CHECK_COMMAND, () => runCheckCommand(diagnosticCollection)),
  );
}

export function deactivate(): void {
  // No-op: everything activate() starts is registered on
  // context.subscriptions, which VSCode disposes on deactivation.
}
