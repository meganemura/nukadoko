import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/index.js";
import { quoteForCmd, resolveWindowsCommand, windowsSpawnPlan } from "../src/context/windows-command.js";

// Responsibility: how runCommand starts a program on Windows. The lookup and
// the quoting are plain functions, checked on every platform; the last block
// starts real .cmd files through cmd.exe and runs only on Windows.

const env = { Path: "C:\\tools;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };

describe("resolveWindowsCommand", () => {
  it("finds a bare name with PATHEXT's first extension in PATH's first directory that holds it", () => {
    const files = new Set(["C:\\Program Files\\nodejs\\npm.CMD", "C:\\Program Files\\nodejs\\npm"]);
    expect(resolveWindowsCommand("npm", env, (file) => files.has(file))).toBe("C:\\Program Files\\nodejs\\npm.CMD");
  });

  it("prefers an earlier PATHEXT extension in the same directory", () => {
    const files = new Set(["C:\\tools\\tool.EXE", "C:\\tools\\tool.CMD"]);
    expect(resolveWindowsCommand("tool", env, (file) => files.has(file))).toBe("C:\\tools\\tool.EXE");
  });

  it("returns a name with a directory or an extension, and a name nothing holds, as given", () => {
    const all = () => true;
    expect(resolveWindowsCommand("C:\\x\\npm", env, all)).toBe("C:\\x\\npm");
    expect(resolveWindowsCommand("./npm", env, all)).toBe("./npm");
    expect(resolveWindowsCommand("npm.cmd", env, all)).toBe("npm.cmd");
    expect(resolveWindowsCommand("npm", env, () => false)).toBe("npm");
  });
});

describe("windowsSpawnPlan", () => {
  it("starts an .exe directly", () => {
    expect(windowsSpawnPlan("C:\\node.exe", ["-e", "1"], env)).toEqual({ file: "C:\\node.exe", args: ["-e", "1"], verbatim: false });
  });

  it("starts a .cmd through ComSpec with each argument quoted and escaped", () => {
    const plan = windowsSpawnPlan("npm", ["pack", "a b", 'say "hi"'], env, (file) => file === "C:\\Program Files\\nodejs\\npm.CMD");
    expect(plan).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\Program^ Files\\nodejs\\npm.CMD ^"pack^" ^"a^ b^" ^"say^ \\^"hi\\^"^""'],
      verbatim: true,
    });
  });

  it("escapes a node_modules/.bin shim's arguments twice", () => {
    const plan = windowsSpawnPlan("C:\\app\\node_modules\\.bin\\tsc.cmd", ["a&b"], env);
    expect(plan.args[3]).toBe('"C:\\app\\node_modules\\.bin\\tsc.cmd ^^^"a^^^&b^^^""');
  });
});

// What cmd.exe does to a line with no quote it reads as a quote: each caret
// escapes the next character.
const uncaret = (line: string): string => line.replace(/\^(.)/gs, "$1");

// How the C runtime reads one argument: 2n backslashes before a quote are n
// backslashes and the quote toggles quoting; 2n+1 are n and a literal quote.
function readOneArgument(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    let slashes = 0;
    while (text[i] === "\\") {
      slashes++;
      i++;
    }
    if (text[i] === '"') {
      out += "\\".repeat(Math.floor(slashes / 2));
      if (slashes % 2 === 1) out += '"';
      i++;
    } else {
      out += "\\".repeat(slashes);
      if (i < text.length) out += text[i++];
    }
  }
  return out;
}

describe("quoteForCmd", () => {
  it("reads back as the same argument after cmd.exe's caret pass, once or twice", () =>
    hegel.test(
      (tc) => {
        const arg = tc.draw(gs.text({ alphabet: 'ab \\"%^!&|<>()[];,*?`=\t' }));
        expect(readOneArgument(uncaret(quoteForCmd(arg, false)))).toBe(arg);
        expect(readOneArgument(uncaret(uncaret(quoteForCmd(arg, true))))).toBe(arg);
      },
      { testCases: 200 },
    ));
});

describe.runIf(process.platform === "win32")("runCommand on Windows", () => {
  // A plain batch file, and one shaped like the shims npm writes under
  // node_modules/.bin, whose last line hands %* to cmd.exe once more.
  const plain = '@node "%~dp0echo.js" %*\r\n';
  const shim = [
    "@ECHO off",
    "SETLOCAL",
    'SET "_prog=node"',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%~dp0..\\..\\echo.js" %*',
    "",
  ].join("\r\n");
  const script = "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n";

  it("starts a bare name that PATH holds as a .cmd, and passes every argument through unchanged", () =>
    hegel.testAsync(
      async (tc) => {
        const dir = mkdtempSync(path.join(tmpdir(), "nukadoko-cmd-"));
        try {
          const bin = path.join(dir, "node_modules", ".bin");
          mkdirSync(bin, { recursive: true });
          writeFileSync(path.join(dir, "echo.js"), script);
          writeFileSync(path.join(dir, "echo-args.cmd"), plain);
          writeFileSync(path.join(bin, "shim-args.cmd"), shim);
          const args = tc.draw(gs.arrays(gs.text({ alphabet: 'ab \\"%^!&|<>()', maxSize: 8 }), { maxSize: 3 }));
          // Windows spells the key Path; a second key in another case would leave the lookup two answers.
          const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
          childEnv.PATH = `${dir};${bin};${process.env.PATH ?? ""}`;
          for (const name of ["echo-args", "shim-args"]) {
            const result = await runCommand(name, args, { env: childEnv });
            expect(result.exitCode, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual(args);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      { testCases: 25 },
    ));

  it("starts npm by its bare name", async () => {
    const result = await runCommand("npm", ["--version"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
