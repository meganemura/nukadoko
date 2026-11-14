import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { childProcessDetail, programName, shellWords } from "../src/context/child-process-detail.js";

// Responsibility: the line `observed.unmeasured` keeps for a process a
// step started without `runCommand` (src/context/child-process-detail.ts):
// the program's last path segment and the argument count, and never any
// argument. The arguments are drawn from characters the fixed words of the
// line never use, so "none of those characters in the line" is the exact
// statement that no argument, whole or in part, reached it. Whatever the
// call was given, on any platform, the line holds no `=` (no assignment,
// no `--token=...`) and no path separator (no directory, which can name
// a user).

const ARGUMENT_ALPHABET = "#%&=@!~^ \t'\"\\$";
const LEAKED = /[#%&=@!~^$]/;
const argument = gs.text({ alphabet: ARGUMENT_ALPHABET, minSize: 1, maxSize: 12 });
const program = gs.text({ alphabet: "abcdefghijklmnopqrstuvwxyz-", minSize: 1, maxSize: 10 });

/** `word` in single quotes, the way a shell reads it back as one word. */
function quoted(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

describe("shellWords", () => {
  it("reads back the words a command line quoted", () =>
    hegel.test((tc) => {
      const words = tc.draw(gs.arrays(gs.text({ maxSize: 8 }), { maxSize: 6 }));
      expect(shellWords(words.map(quoted).join(" "))).toEqual(words);
    }));

  it("splits on whitespace outside quotes, and keeps a quoted or escaped space in its word", () => {
    expect(shellWords(`git  commit -m "two words" a\\ b ''`)).toEqual(["git", "commit", "-m", "two words", "a b", ""]);
  });

  it("keeps a backslash as a character on Windows, where only double quotes group", () => {
    expect(shellWords(`"C:\\Program Files\\Git\\bin\\git.exe" status C:\\a\\b 'x y'`, "windows")).toEqual([
      "C:\\Program Files\\Git\\bin\\git.exe",
      "status",
      "C:\\a\\b",
      "'x",
      "y'",
    ]);
  });
});

describe("childProcessDetail", () => {
  it("names the program and counts the arguments of every call form, and never keeps an argument", () =>
    hegel.test((tc) => {
      const name = tc.draw(program);
      const args = tc.draw(gs.arrays(argument, { maxSize: 5 }));
      const call = tc.draw(gs.sampledFrom(["exec", "execSync", "spawn", "spawnSync", "execFile", "execFileSync", "fork", "shell"] as const));
      const detail =
        call === "exec" || call === "execSync"
          ? childProcessDetail(call, [[name, ...args.map(quoted)].join(" "), () => undefined], "linux")
          : call === "shell"
            ? childProcessDetail("spawn", [[name, ...args.map(quoted)].join(" "), { shell: true }], "linux")
            : childProcessDetail(call, [`/opt/tools/${name}`, args, {}], "linux");
      expect(detail).not.toMatch(LEAKED);
      expect(detail).toBe(`${call === "shell" ? "spawn" : call} ${name} with ${args.length} ${args.length === 1 ? "argument" : "arguments"}`);
    }));

  it("never holds a = or a path separator, whatever the call was given, on any platform", () =>
    hegel.test((tc) => {
      const call = tc.draw(gs.sampledFrom(["exec", "execSync", "spawn", "spawnSync", "execFile", "execFileSync", "fork"] as const));
      const first = tc.draw(gs.text({ alphabet: "ab=/\\:'\" \t", maxSize: 16 }));
      const list = tc.draw(gs.arrays(gs.text({ alphabet: "a=/\\", maxSize: 4 }), { maxSize: 3 }));
      const shell = tc.draw(gs.sampledFrom<unknown>([undefined, true, false, "/bin/sh", "cmd.exe", "C:\\Windows\\System32\\cmd.exe"]));
      const platform = tc.draw(gs.sampledFrom<NodeJS.Platform>(["linux", "darwin", "win32"]));
      const detail = childProcessDetail(call, tc.draw(gs.booleans()) ? [first, list, { shell }] : [first, { shell }], platform);
      expect(detail).not.toMatch(/[=/\\]/);
    }));

  it("names the program after a shell line's leading assignments, and does not count them", () =>
    hegel.test((tc) => {
      const assignments = tc.draw(gs.arrays(gs.text({ alphabet: "ABC_xyz=/:", minSize: 1, maxSize: 8 }), { maxSize: 3 })).map((value, index) => `V${index}=${value}`);
      const name = tc.draw(program);
      const args = tc.draw(gs.arrays(argument, { maxSize: 3 }));
      const call = tc.draw(gs.sampledFrom(["exec", "execSync"] as const));
      const line = [...assignments, `/usr/local/bin/${name}`, ...args.map(quoted)].join(" ");
      expect(childProcessDetail(call, [line], "linux")).toBe(`${call} ${name} with ${args.length} ${args.length === 1 ? "argument" : "arguments"}`);
    }));

  it("names a Windows program by its last segment, quoted or not, with or without spaces in its path", () =>
    hegel.test((tc) => {
      const segments = tc.draw(gs.arrays(gs.text({ alphabet: "abc ", minSize: 1, maxSize: 6 }), { minSize: 1, maxSize: 3 }));
      const name = tc.draw(program);
      const path = `C:\\${[...segments, `${name}.exe`].join("\\")}`;
      const args = tc.draw(gs.arrays(gs.text({ alphabet: "abc-\\", minSize: 1, maxSize: 5 }), { maxSize: 3 }));
      const shown = path.includes(" ") || tc.draw(gs.booleans()) ? `"${path}"` : path;
      expect(childProcessDetail("exec", [[shown, ...args].join(" ")], "win32")).toBe(`exec ${name}.exe with ${args.length} ${args.length === 1 ? "argument" : "arguments"}`);
    }));

  it("counts a shell line's words and the list a shell call also got", () => {
    expect(childProcessDetail("spawn", ["git push", ["--force"], { shell: "/bin/sh" }], "linux")).toBe("spawn git with 2 arguments");
    expect(childProcessDetail("execFile", [new URL("file:///usr/bin/env")], "linux")).toBe("execFile env with 0 arguments");
    expect(childProcessDetail("fork", ["./worker.js"], "linux")).toBe("fork worker.js with 0 arguments");
  });

  it("leaves out an assignment, a name with a =, and a directory, on each platform", () => {
    expect(
      [
        childProcessDetail("exec", ["GITHUB_TOKEN=ghp_invented gh api /user"], "linux"),
        childProcessDetail("execSync", ["PGPASSWORD=invented psql -c 'select 1'"], "linux"),
        childProcessDetail("spawn", ["API_KEY=invented curl https://x", { shell: true }], "linux"),
        childProcessDetail("spawn", ["https://user:invented@host/thing"], "linux"),
        childProcessDetail("spawn", ["--token=invented"], "linux"),
        childProcessDetail("exec", ["A=1"], "linux"),
        childProcessDetail("exec", ["C:\\Users\\alice\\proj\\bin\\tool.exe --flag"], "win32"),
        childProcessDetail("exec", ['"C:\\Program Files\\Git\\bin\\git.exe" status'], "win32"),
        childProcessDetail("execFile", ["C:\\Users\\alice\\proj\\bin\\tool.exe", ["a"]], "linux"),
        childProcessDetail("spawn", ["C:\\tools\\x.exe a\\b", { shell: "cmd.exe" }], "linux"),
      ],
    ).toEqual([
      "exec gh with 2 arguments",
      "execSync psql with 2 arguments",
      "spawn curl with 1 argument",
      "spawn thing with 0 arguments",
      "spawn (name hidden: it holds an equals sign) with 0 arguments",
      "exec (no program) with 0 arguments",
      "exec tool.exe with 1 argument",
      "exec git.exe with 1 argument",
      "execFile tool.exe with 1 argument",
      "spawn x.exe with 1 argument",
    ]);
  });

  it("reads a path the way path.basename does, at either separator", () => {
    expect(["/usr/bin/git", "C:\\a\\b.exe", "dir/", "mixed\\a/b", "", "/"].map(programName)).toEqual(["git", "b.exe", "dir", "b", "", ""]);
  });
});
