#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    await runInherit("npm", ["install", tarballPath], { cwd: projectDir });

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
