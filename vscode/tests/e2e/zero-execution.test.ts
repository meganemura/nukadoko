// Responsibility: prove the zero-execution property one level above where
// tests/extraction/zero-execution.test.ts and tests/index/build-index.test.
// ts's own "zero execution" describe block already prove it -- not "does a
// pure function avoid importing a step file" but "does the whole bundled
// extension, activated in a fake workspace and driven the way VSCode itself
// would drive it (open a file, ask for a definition, ask for completions),
// ever run anything the open workspace owns". dist/extension.js is the
// actual artifact `vsce package` ships; running the un-bundled src/
// extension.ts instead would prove something about source code a user
// never runs.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVscodeStub, installVscodeModule, requireFreshExtension, type VscodeStub } from "./vscode-stub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const distExtensionPath = path.join(here, "..", "..", "dist", "extension.js");

describe("dist/extension.js: zero execution", () => {
  let tmpDir: string;
  let markerPath: string;
  let stub: VscodeStub;
  let restoreModuleLoad: () => void;

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-vscode-zero-exec-"));
    markerPath = path.join(tmpDir, "marker.txt");

    stub = createVscodeStub();
    stub.files.set(
      "/fake-workspace/features/steps/add-todo.ts",
      [
        'import { defineStep } from "nukadoko";',
        'import { z } from "zod";',
        "",
        "export default defineStep({",
        '  pattern: "a todo titled {title:string} is added",',
        '  description: "normal step, no side effect",',
        "  args: z.object({ title: z.string() }),",
        "  returns: z.object({ title: z.string() }),",
        "  mutates: true,",
        "  run(_fixtures, args) { return args; },",
        "});",
        "",
      ].join("\n"),
    );
    // Mirrors tests/fixtures/side-effecting-step.ts's own trick one level
    // down: a marker write at top level, which must never fire because
    // nothing in this pipeline may import or evaluate a workspace file --
    // only read its text (createWorkspaceFileSource) and parse it
    // (extractStepDeclarations, tree-sitter). It also declares a real,
    // separately-named step (same shape as that sibling fixture), so this
    // test's own positive control -- both patterns showing up in
    // completions -- proves the marker's absence means "this file's
    // top-level code never ran," not "this file was skipped and never
    // reached at all."
    stub.files.set(
      "/fake-workspace/features/steps/side-effecting.ts",
      [
        'import { writeFileSync } from "node:fs";',
        'import { defineStep } from "nukadoko";',
        'import { z } from "zod";',
        `writeFileSync(${JSON.stringify(markerPath)}, "this file ran");`,
        "",
        "export default defineStep({",
        '  pattern: "a side effecting step is parsed",',
        '  description: "the write above must never run, even though this declaration is found",',
        "  args: z.object({}),",
        "  returns: z.object({}),",
        "  mutates: false,",
        "  run() { return {}; },",
        "});",
        "",
      ].join("\n"),
    );

    restoreModuleLoad = installVscodeModule(stub);
  });

  afterAll(() => {
    restoreModuleLoad();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("never writes the fixture's own top-level side effect through activate + definition + completion", async () => {
    expect(existsSync(markerPath)).toBe(false);

    const extension = requireFreshExtension(distExtensionPath);
    const context = { subscriptions: [] as { dispose(): void }[] };
    extension.activate(context);

    expect(existsSync(markerPath)).toBe(false);

    // Positive control: the pipeline must actually have run (found the
    // normal step), not merely have thrown or no-opped its way to an
    // absent marker -- an absent marker that also means nothing ran would
    // pass for the wrong reason.
    expect(stub.definitionProvider).toBeDefined();
    expect(stub.completionProvider).toBeDefined();

    const fakeDocument = {
      lineAt(line: number) {
        return { text: line === 0 ? 'Given a todo titled "Buy milk" is added' : "" };
      },
    };
    const definitions = (await stub.definitionProvider?.provideDefinition(fakeDocument, { line: 0, character: 0 })) as
      | { uri: { fsPath: string } }[]
      | undefined;
    expect(definitions).toEqual([
      expect.objectContaining({ uri: expect.objectContaining({ fsPath: "/fake-workspace/features/steps/add-todo.ts" }) }),
    ]);

    const completions = (await stub.completionProvider?.provideCompletionItems(fakeDocument, {
      line: 0,
      character: 0,
    })) as { label: string }[] | undefined;
    // Both patterns, not just the definitely-harmless one: proves
    // side-effecting.ts's own declaration was actually found (parsed, never
    // executed), the paired positive proof the marker-absence assertions
    // above need to mean what they claim.
    expect(completions?.map((item) => item.label).sort()).toEqual(
      ["a side effecting step is parsed", "a todo titled {title:string} is added"].sort(),
    );

    expect(existsSync(markerPath)).toBe(false);
  });
});
