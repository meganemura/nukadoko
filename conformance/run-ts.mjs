// Runs every conformance case under the TypeScript engine and prints, or
// compares against expected.json, the part of the result both engines must
// agree on. A step is named by its step name, never its file, because the
// two engines spell step files differently (add-todo.ts, add_todo.rb).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const cli = path.join(root, "dist", "cli.js");
const write = process.argv.includes("--write");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function nuka(dir, args) {
  try {
    return JSON.parse(execFileSync("node", [cli, ...args, "--json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch (error) {
    return JSON.parse(error.stdout);
  }
}

function project(caseDir) {
  const dir = mkdtempSync(path.join(tmpdir(), "nukadoko-conformance-"));
  cpSync(path.join(caseDir, "features"), path.join(dir, "features"), { recursive: true });
  cpSync(path.join(caseDir, "steps-ts"), path.join(dir, "features", "steps"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  mkdirSync(path.join(dir, "node_modules"));
  symlinkSync(root, path.join(dir, "node_modules", "nukadoko"), "dir");
  writeFileSync(path.join(dir, "nukadoko.config.ts"), 'import { defineConfig } from "nukadoko";\n\nexport default defineConfig({});\n');
  const programFile = path.join(caseDir, "program.json");
  if (existsSync(programFile)) {
    const program = readFileSync(programFile, "utf8").replaceAll("{root}", root);
    writeFileSync(path.join(dir, "nukadoko.program.ts"), `import { defineProgram } from "nukadoko";\n\nexport default defineProgram(${program});\n`);
  }
  return dir;
}

function finding(f) {
  const inSteps = f.file?.startsWith("features/steps/");
  const step = f.step ?? (inSteps ? path.basename(f.file).replace(/\.[^.]+$/, "") : undefined);
  const file = f.file && !inSteps ? f.file : undefined;
  return { severity: f.severity, code: f.code, ...(file ? { file, line: f.line } : {}), ...(step ? { step } : {}) };
}

function outcome(caseDir) {
  const dir = project(caseDir);
  try {
    const check = nuka(dir, ["check"]);
    const result = { check: check.findings.map(finding) };
    if (check.verdict === "passed") {
      const run = nuka(dir, ["run", "--no-check"]);
      result.scenarios = run.scenarios.map((s) => ({
        feature: s.feature,
        line: s.line,
        status: s.status,
        steps: s.steps.map((step) => ({ line: step.line, step: step.step, status: step.status })),
      }));
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let failed = 0;
for (const name of readdirSync(path.join(here, "cases")).sort()) {
  if (only.length > 0 && !only.includes(name)) continue;
  const caseDir = path.join(here, "cases", name);
  const actual = `${JSON.stringify(outcome(caseDir), null, 2)}\n`;
  const expectedFile = path.join(caseDir, "expected.json");
  if (write) {
    writeFileSync(expectedFile, actual);
    console.log(`wrote ${path.relative(root, expectedFile)}`);
  } else if (readFileSync(expectedFile, "utf8") === actual) {
    console.log(`ok      ${name}`);
  } else {
    failed += 1;
    console.log(`differs ${name}\n${actual}`);
  }
}
process.exitCode = failed > 0 ? 1 : 0;
