#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Responsibility: prove the published tarball works stand-alone, not just
// that this repository's own checked-out tree does. `npm test` never
// installs the tarball into a project that has only the tarball's own
// declared dependencies, so a `bin` that needs a package this package only
// lists as a devDependency, or a `dist/` that is stale or missing because
// `prepublishOnly` was skipped (this repository runs with
// `ignore-scripts=true`, and that hook does not fire under it), passes
// every existing check and still breaks on the first command a real
// install runs. This script packs the real tarball, installs it into a
// project outside this repository's own directory tree, and drives the
// CLI the way an installer would, so a missing runtime dependency or a
// stale `dist/` shows up here instead of after publish.
//
// Deliberately outside this repository's own node_modules tree, not
// nested under it: Node resolves a bare specifier such as `tsx` by walking
// up through every ancestor `node_modules`, so an install target inside
// this repository would find this repository's own node_modules (which
// mixes dependencies and devDependencies) and silently paper over exactly
// the missing-runtime-dependency failure this script exists to catch.
// `os.tmpdir()` has no such ancestor, which is what makes the check
// honest.
//
// Node standard library only, no new dependency: this script itself ships
// nowhere (it is not in `package.json`'s `files`), so it costs nothing to
// keep separate from the package's own dependency budget, and every
// dependency it would otherwise reach for (child_process, fs, os, path) is
// already built in.

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function log(message) {
  console.log(`pack-check: ${message}`);
}

// Runs a command with its stdout and stderr connected straight to this
// process's own, so a long-running step (an npm install, the CLI itself)
// is visible while it runs rather than only after it fails.
function runInherit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} was killed by signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

// Runs a command and returns its stdout, for the one step (`npm pack
// --json`) whose output this script has to parse rather than just watch.
async function runCapture(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, { cwd: repoRoot, ...options });
  return stdout;
}

// Captures diagnostics in a file while retaining the compiler's own exit
// code. A shell pipeline would report the last process's status instead.
async function runTypeScriptCapture(args, cwd, outputPath) {
  const output = await open(outputPath, "w");
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(path.join(repoRoot, "node_modules", ".bin", "tsc"), args, {
        cwd,
        stdio: ["ignore", output.fd, output.fd],
      });
      child.on("error", reject);
      child.on("exit", (exitCode, signal) => {
        if (signal) {
          reject(new Error(`tsc ${args.join(" ")} was killed by signal ${signal}`));
        } else {
          resolve(exitCode);
        }
      });
    });
    return code;
  } finally {
    await output.close();
  }
}

// Both optional peers are left out of the install (`--omit=peer`), so every
// stage below runs the way a project that never opens a browser and never
// talks to an MCP server would.
const OPTIONAL_PEERS = ["@modelcontextprotocol/client", "playwright"];

async function verifyOptionalPeerTypeIsolation(projectDir) {
  const checkDir = path.join(projectDir, "peer-isolation");
  await mkdir(checkDir, { recursive: true });

  for (const peer of OPTIONAL_PEERS) {
    const peerDir = path.join(projectDir, "node_modules", ...peer.split("/"));
    try {
      await access(peerDir);
      throw new Error(`optional peer is present in the isolated project: ${peerDir}`);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const compilerOptions = {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2022",
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    typeRoots: [path.join(repoRoot, "node_modules", "@types")],
    types: ["node"],
  };
  const cases = [
    {
      // The public surfaces name Playwright's types (`page`, `request`)
      // through `import type`. With `skipLibCheck: true`, the setting most
      // projects use, those resolve to `any` when `playwright` is absent and
      // a project without it still compiles.
      name: "public-surfaces",
      skipLibCheck: true,
      source: [
        'import * as core from "nukadoko";',
        'import * as compat from "nukadoko/compat";',
        'import * as matching from "nukadoko/matching";',
        "void [core, compat, matching];",
      ].join("\n"),
    },
    {
      // With `skipLibCheck: false`, a hand-written strict tsconfig's default,
      // the same surfaces still compile: the build puts a `// @ts-ignore` on
      // every declaration line that imports from `playwright`
      // (scripts/guard-playwright-types.ts), so a missing peer is `any`
      // instead of TS2307.
      name: "public-surfaces-checked-libs",
      source: [
        'import * as core from "nukadoko";',
        'import * as compat from "nukadoko/compat";',
        'import * as matching from "nukadoko/matching";',
        "void [core, compat, matching];",
      ].join("\n"),
    },
    {
      name: "negative-control",
      source: 'import { __nukadoko_missing_export__ } from "nukadoko";\nvoid __nukadoko_missing_export__;',
    },
    {
      name: "mcp-surface",
      source: 'import * as mcp from "nukadoko/mcp";\nvoid mcp;',
    },
  ];

  const results = new Map();
  for (const checkCase of cases) {
    const sourcePath = path.join(checkDir, `${checkCase.name}.ts`);
    const configPath = path.join(checkDir, `${checkCase.name}.json`);
    const outputPath = path.join(checkDir, `${checkCase.name}.out`);
    await writeFile(sourcePath, `${checkCase.source}\n`);
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          compilerOptions: { ...compilerOptions, skipLibCheck: checkCase.skipLibCheck ?? false },
          files: [sourcePath],
        },
        null,
        2,
      )}\n`,
    );
    const code = await runTypeScriptCapture(["--pretty", "false", "-p", configPath], checkDir, outputPath);
    results.set(checkCase.name, { code, output: await readFile(outputPath, "utf8") });
  }

  const publicResult = results.get("public-surfaces");
  if (publicResult.code !== 0) {
    throw new Error(`public type surfaces failed without the optional peers:\n${publicResult.output}`);
  }
  log("public type surfaces passed without the optional peers");

  const checkedLibsResult = results.get("public-surfaces-checked-libs");
  if (checkedLibsResult.code !== 0) {
    throw new Error(
      `public type surfaces failed under skipLibCheck: false without the optional peers:\n${checkedLibsResult.output}`,
    );
  }
  log("public type surfaces passed under skipLibCheck: false without the optional peers");

  const negativeResult = results.get("negative-control");
  if (negativeResult.code === 0) {
    throw new Error("negative typecheck control passed despite importing a missing export");
  }
  log("negative typecheck control failed as expected");

  const mcpResult = results.get("mcp-surface");
  if (mcpResult.code === 0) {
    throw new Error("nukadoko/mcp passed without its optional peer");
  }
  const diagnostics = mcpResult.output.split("\n").filter((line) => /\berror TS\d+:/.test(line));
  const unrelatedDiagnostics = diagnostics.filter((line) => !line.includes("@modelcontextprotocol/client"));
  if (diagnostics.length === 0 || unrelatedDiagnostics.length > 0) {
    throw new Error(
      `nukadoko/mcp did not fail only for the optional peer:\n${mcpResult.output}`,
    );
  }
  log("nukadoko/mcp failed only for the missing optional peer");
}

// A project with `declaration: true` (what `tsc --init` writes, and what
// every library and every `composite` workspace has) emits a `.d.ts` for
// each step file, and a step's type is inferred from `defineStep`. Every
// name that inferred type reaches has to be exported from the package
// entry, or tsc stops with TS2742 on a step that declares no `returns`.
// The scaffolded steps are each shape `nuka scaffold` writes.
async function verifyDeclarationEmit(projectDir, nukaBin) {
  await runInherit(nukaBin, ["scaffold", "output-is-empty", "--pattern", "the output is empty", "--then"], {
    cwd: projectDir,
  });
  await runInherit(nukaBin, ["scaffold", "plain-stub", "--pattern", "nothing happens yet"], { cwd: projectDir });
  const configPath = path.join(projectDir, "tsconfig.declarations.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          skipLibCheck: false,
          declaration: true,
          composite: true,
          outDir: "declarations-out",
          typeRoots: [path.join(repoRoot, "node_modules", "@types")],
          types: ["node"],
        },
        include: ["features/**/*", "nukadoko.config.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const outputPath = path.join(projectDir, "declarations.out");
  const code = await runTypeScriptCapture(["--pretty", "false", "-p", configPath], projectDir, outputPath);
  if (code !== 0) {
    throw new Error(`step files failed to emit declarations:\n${await readFile(outputPath, "utf8")}`);
  }
  const emitted = await readFile(path.join(projectDir, "declarations-out", "features", "steps", "output-is-empty.d.ts"), "utf8");
  if (!emitted.includes('import("nukadoko").DefaultReturns') || emitted.includes("node_modules")) {
    throw new Error(`a step's emitted declaration does not name the package entry:\n${emitted}`);
  }
  log("step files emitted declarations that name the package entry");
}

async function writeNoBrowserProject(projectDir) {
  const stepsDir = path.join(projectDir, "features", "steps");
  await mkdir(stepsDir, { recursive: true });
  await writeFile(
    path.join(stepsDir, "run-node.ts"),
    [
      'import { defineStep, runCommand, z } from "nukadoko";',
      "",
      "export default defineStep({",
      '  description: "Run node and print a word",',
      '  pattern: "node prints {word:string}",',
      "  args: z.object({ word: z.string() }),",
      "  async run({ scratch }, { word }) {",
      '    const { stdout } = await runCommand(process.execPath, ["-e", `console.log(${JSON.stringify(word)})`], {',
      "      cwd: scratch.dir(),",
      "    });",
      '    if (stdout.trim() !== word) throw new Error(`printed "${stdout.trim()}"`);',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(stepsDir, "open-page.ts"),
    [
      'import { defineStep, z } from "nukadoko";',
      "",
      "export default defineStep({",
      '  description: "Open a blank page",',
      '  pattern: "a blank page is open",',
      "  args: z.object({}),",
      "  async run({ page }) {",
      '    await page.goto("about:blank");',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(projectDir, "features", "cli.feature"),
    'Feature: cli\n\n  Scenario: prints\n    When node prints "hello"\n',
  );
  await writeFile(
    path.join(projectDir, "features", "browser.feature"),
    "Feature: browser\n\n  Scenario: opens a page\n    Given a blank page is open\n",
  );
}

async function main() {
  // Named after the step about to run, not the step that just finished,
  // so a thrown error always describes the stage that was in progress.
  // `npm run build` itself is not a stage here: `package.json`'s
  // `pack-check` script chains it with `&&` before this file ever starts,
  // the same pattern `test`, `typecheck`, `coverage`, and `selftest` all
  // already use in this repository, rather than this script shelling out
  // to it a second time.
  let stage = "npm pack";
  let tmpDir;
  try {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "nukadoko-pack-check-"));
    const packOutput = await runCapture("npm", ["pack", "--json", "--pack-destination", tmpDir]);
    const [{ filename }] = JSON.parse(packOutput);
    const tarballPath = path.join(tmpDir, filename);
    log(`packed ${filename}`);

    stage = "scaffold install target";
    const projectDir = path.join(tmpDir, "project");
    await mkdir(projectDir, { recursive: true });
    await runInherit("npm", ["init", "-y"], { cwd: projectDir });
    // README.md states plainly that a project's own package.json needs
    // `"type": "module"`; a project without it is not the shape this
    // package is meant to install into, so the check would prove nothing
    // about the shape users actually have.
    const projectPackageJsonPath = path.join(projectDir, "package.json");
    const projectPackageJson = JSON.parse(await readFile(projectPackageJsonPath, "utf8"));
    projectPackageJson.type = "module";
    await writeFile(projectPackageJsonPath, `${JSON.stringify(projectPackageJson, null, 2)}\n`);

    stage = "npm install <tarball>";
    await runInherit("npm", ["install", "--omit=peer", tarballPath], { cwd: projectDir });

    const nukaBin = path.join(projectDir, "node_modules", ".bin", "nuka");

    stage = "nuka --version";
    await runInherit(nukaBin, ["--version"], { cwd: projectDir });

    stage = "nuka init";
    await runInherit(nukaBin, ["init"], { cwd: projectDir });

    stage = "nuka steps";
    // The one call in this whole check that proves the installed
    // package's own `tsx` dependency resolves at runtime: `nuka steps`
    // loads `nukadoko.config.ts` (written by `nuka init` just above)
    // through tsx's runtime `register()` call
    // (src/discover/discover-steps.ts), which is the exact code path that
    // broke, in a different project, when a `bin`'s own runtime dependency
    // was reachable only in that project's own checked-out tree and not
    // from an installed tarball.
    await runInherit(nukaBin, ["steps"], { cwd: projectDir });

    stage = "nuka run without playwright";
    // `playwright` is an optional peer, left out above: a scenario that never
    // opens a browser runs green, and a step that asks for `page` fails with
    // the install command rather than a module resolution stack.
    await writeNoBrowserProject(projectDir);
    await runInherit(nukaBin, ["run", "features/cli.feature"], { cwd: projectDir });
    const browserRun = await new Promise((resolve, reject) => {
      execFile(nukaBin, ["run", "features/browser.feature"], { cwd: projectDir }, (error, _stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ code: error ? error.code : 0, stderr });
      });
    });
    if (browserRun.code === 0 || !browserRun.stderr.includes('needs "playwright"') ||
        !browserRun.stderr.includes("npm install -D -E playwright@")) {
      throw new Error(`a page step without playwright did not fail with the install command:\n${browserRun.stderr}`);
    }
    log("a page step without playwright failed with the install command");

    stage = "tsc with declaration: true";
    await verifyDeclarationEmit(projectDir, nukaBin);

    stage = "verify shipped files";
    const installedPackageDir = path.join(projectDir, "node_modules", "nukadoko");
    // Beyond `dist/`: README.md states the package "ships its own
    // TypeScript source alongside dist/", and AGENTS.md's comment rules
    // depend on that source being reachable from inside node_modules;
    // `nuka skill path` (see skills/) resolves into the installed
    // `skills/` directory the same way. Both are promises this script has
    // to check against the real install, not against package.json's
    // `files` list, since a list is a declaration and this check exists
    // to test what actually happened.
    const mustExist = [
      path.join(installedPackageDir, "dist", "cli.js"),
      path.join(installedPackageDir, "src"),
      path.join(installedPackageDir, "skills"),
    ];
    const missing = [];
    for (const target of mustExist) {
      try {
        await access(target);
      } catch {
        missing.push(target);
      }
    }
    if (missing.length > 0) {
      throw new Error(`missing from the installed package: ${missing.join(", ")}`);
    }

    // The inverse check: vscode/ is its own npm project (its own
    // package.json, its own dependencies, released on its own vscode-v*
    // schedule per .github/workflows/vscode-extension.yml), never a thing
    // this package's own consumers install. package.json's own `files`
    // list already leaves it out, by omission rather than an explicit
    // exclude entry, which is exactly the kind of promise that silently
    // stops holding the moment someone adds a broader entry to that list;
    // this checks the real install, not the list itself.
    const mustNotExist = [path.join(installedPackageDir, "vscode")];
    const unexpectedlyPresent = [];
    for (const target of mustNotExist) {
      try {
        await access(target);
        unexpectedlyPresent.push(target);
      } catch {
        // Not found is the passing case here.
      }
    }
    if (unexpectedlyPresent.length > 0) {
      throw new Error(`present in the installed package but should not be: ${unexpectedlyPresent.join(", ")}`);
    }

    stage = "verify optional peer type isolation";
    await verifyOptionalPeerTypeIsolation(projectDir);

    log("all stages passed");
  } catch (err) {
    console.error(`pack-check: failed at stage "${stage}": ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (tmpDir) {
      // Runs even on failure: a check that leaves its own scratch files
      // behind when it fails is the case someone hits most, since a
      // failure is exactly when this script gets run again right away.
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

await main();
