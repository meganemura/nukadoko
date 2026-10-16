// Responsibility: the reverse of tests/e2e/zero-execution.test.ts's own
// proof -- that the one command this extension registers (nukadoko.check)
// really does spawn `nuka check` and turn its report into diagnostics, and
// that nothing before that command runs does. The command handler's own
// logic (JSON -> DiagnosticsEntry[]) is already unit-tested through
// readCheckReport (tests/diagnostics/build-diagnostics.
// test.ts); what only an end-to-end run through the bundled dist/
// extension.js can show is that the wiring between "a user runs this
// command" and "a real `nuka` process starts" actually holds.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
const nukaBinPath = path.join(fixtureDir, "node_modules", ".bin", "nuka");
const featureFilePath = path.join(fixtureDir, "features", "todo.feature");
const noisyFixtureDir = path.join(here, "fixtures", "noisy-check-workspace");

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
function writeNukaShim(workspaceDir: string): void {
  const binDir = path.join(workspaceDir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "nuka"), `#!/bin/sh\nexec node ${JSON.stringify(distCliPath)} "$@"\n`);
  chmodSync(path.join(binDir, "nuka"), 0o755);
}

function activateIn(workspaceDir: string): { stub: VscodeStub; restoreModuleLoad: () => void } {
  const stub = createVscodeStub();
  stub.workspaceFolders = [{ uri: { fsPath: workspaceDir, toString: () => `file://${workspaceDir}` } }];
  const restoreModuleLoad = installVscodeModule(stub);
  requireFreshExtension(distExtensionPath).activate({ subscriptions: [] });
  return { stub, restoreModuleLoad };
}

describe("nukadoko.check: the one command allowed to run workspace code", () => {
  let stub: VscodeStub;
  let restoreModuleLoad: () => void;

  beforeAll(() => {
    writeNukaShim(fixtureDir);
    ({ stub, restoreModuleLoad } = activateIn(fixtureDir));
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

describe("nukadoko.check: a step file that prints on stdout when it is imported", () => {
  let stub: VscodeStub;
  let restoreModuleLoad: () => void;

  beforeAll(() => {
    writeNukaShim(noisyFixtureDir);
    ({ stub, restoreModuleLoad } = activateIn(noisyFixtureDir));
  });

  afterAll(() => {
    restoreModuleLoad();
    rmSync(path.join(noisyFixtureDir, "node_modules"), { recursive: true, force: true });
  });

  it(
    "names the line that is not JSON and clears the diagnostics of an earlier run",
    async () => {
      const staleFile = path.join(noisyFixtureDir, "features", "noisy.feature");
      stub.diagnosticCollection?.set({ fsPath: staleFile, toString: () => `file://${staleFile}` }, [
        { message: "from an earlier run", severity: 0, code: "undefined-step" },
      ]);

      await stub.commands.get(CHECK_COMMAND)?.();

      expect(stub.errorMessages).toEqual([
        'nukadoko: Check could not read the output of nuka check --json as a report. The output starts with "noisy-step loaded". A step file may print to stdout when it is imported.',
      ]);
      expect(stub.diagnosticCollection?.entries.size).toBe(0);
    },
    60_000,
  );
});

describe("nukadoko.check: a run that exits 0 and prints nothing", () => {
  let workspaceDir: string;
  let stub: VscodeStub;
  let restoreModuleLoad: () => void;

  beforeAll(() => {
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-vscode-silent-check-"));
    const binDir = path.join(workspaceDir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "nuka"), "#!/bin/sh\necho\nexit 0\n");
    chmodSync(path.join(binDir, "nuka"), 0o755);
    ({ stub, restoreModuleLoad } = activateIn(workspaceDir));
  });

  afterAll(() => {
    restoreModuleLoad();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("says nuka check printed nothing", async () => {
    await stub.commands.get(CHECK_COMMAND)?.();

    expect(stub.errorMessages).toEqual([
      "nukadoko: Check got no output from nuka check --json, so there is no report to show.",
    ]);
  });
});
