// Responsibility: the reverse of tests/e2e/zero-execution.test.ts's own
// proof -- that the one command this extension registers (nukadoko.check)
// really does spawn `nuka check` and turn its report into diagnostics, and
// that nothing before that command runs does. The command handler's own
// logic (JSON -> DiagnosticsEntry[]) is already unit-tested through
// buildDiagnosticsFromCheckReport (tests/diagnostics/build-diagnostics.
// test.ts); what only an end-to-end run through the bundled dist/
// extension.js can show is that the wiring between "a user runs this
// command" and "a real `nuka` process starts" actually holds.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVscodeStub, installVscodeModule, requireFreshExtension, type VscodeStub } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vscodeRoot = path.join(here, "..", "..");
const repoRoot = path.join(vscodeRoot, "..");
const distExtensionPath = path.join(vscodeRoot, "dist", "extension.js");
const distCliPath = path.join(repoRoot, "dist", "cli.js");

const fixtureDir = path.join(here, "fixtures", "diagnostics-workspace");
const nukaBinDir = path.join(fixtureDir, "node_modules", ".bin");
const nukaBinPath = path.join(nukaBinDir, "nuka");
const featureFilePath = path.join(fixtureDir, "features", "todo.feature");

const CHECK_COMMAND = "nukadoko.check";

// A real npm install (`npm install nukadoko`, or scripts/pack-check.mjs's
// own tarball-install technique) would also produce a working
// node_modules/.bin/nuka, but at the cost of a real install for every test
// run. This shim gets the one thing that check actually needs -- a real,
// spawnable file at the exact relative path src/extension.ts's own
// resolveNukaBinaryPath computes -- without paying for that install: `node
// dist/cli.js` behaves identically to the installed `nuka` bin (dist/cli.js
// is itself npm's own bin entry, unwrapped), and re-execing it here is a
// close enough stand-in that the CLI's own correctness stays covered by
// this repository's existing CLI tests rather than re-proven here.
// POSIX-only (a `#!/bin/sh` shebang script, not `.cmd`) -- this repository's
// CI runs ubuntu-latest only (.github/workflows/vscode-extension.yml).
function writeNukaShim(): void {
  mkdirSync(nukaBinDir, { recursive: true });
  writeFileSync(nukaBinPath, `#!/bin/sh\nexec node ${JSON.stringify(distCliPath)} "$@"\n`);
  chmodSync(nukaBinPath, 0o755);
}

describe("nukadoko.check: the one command allowed to run workspace code", () => {
  let stub: VscodeStub;
  let restoreModuleLoad: () => void;

  beforeAll(() => {
    writeNukaShim();

    stub = createVscodeStub();
    stub.workspaceFolders = [
      { uri: { fsPath: fixtureDir, toString: () => `file://${fixtureDir}` } },
    ];

    restoreModuleLoad = installVscodeModule(stub);
    const extension = requireFreshExtension(distExtensionPath);
    extension.activate({ subscriptions: [] });
  });

  afterAll(() => {
    restoreModuleLoad();
    // Ignored by .gitignore's blanket `node_modules/` rule, but a leftover
    // shim bakes this checkout's own absolute repoRoot path into a file
    // that would silently point at the wrong tree after the checkout moves
    // -- removed regardless of whether the test above passed or failed.
    rmSync(path.join(fixtureDir, "node_modules"), { recursive: true, force: true });
  });

  it(
    "activation alone registers the command but runs nothing (no diagnostics yet)",
    () => {
      expect(stub.commands.has(CHECK_COMMAND)).toBe(true);
      expect(stub.diagnosticCollection).toBeDefined();
      expect(stub.diagnosticCollection?.entries.size).toBe(0);
    },
    60_000,
  );

  it(
    "running the command spawns a real `nuka check` and reflects its issue as a diagnostic",
    async () => {
      expect(existsSync(nukaBinPath)).toBe(true);

      const handler = stub.commands.get(CHECK_COMMAND);
      expect(handler).toBeDefined();
      await handler?.();

      expect(stub.errorMessages).toEqual([]);

      const diagnosticsForFeature = stub.diagnosticCollection?.entries.get(featureFilePath);
      expect(diagnosticsForFeature).toBeDefined();
      expect(diagnosticsForFeature).toEqual([
        expect.objectContaining({
          code: "undefined-step",
          severity: 0, // DiagnosticSeverity.Error
          message: expect.stringContaining('No step definition matches "a step nothing in this project defines"'),
        }),
      ]);
    },
    60_000,
  );
});
