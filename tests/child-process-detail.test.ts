import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { childProcessDetail, shellWords } from "../src/context/child-process-detail.js";

// Responsibility: the line `observed.unmeasured` keeps for a process a
// step started without `runCommand` (src/context/child-process-detail.ts):
// the program's last path segment and the argument count, and never any
// argument. The arguments are drawn from characters the fixed words of the
// line never use, so "none of those characters in the line" is the exact
// statement that no argument, whole or in part, reached it.

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
});

describe("childProcessDetail", () => {
  it("names the program and counts the arguments of every call form, and never keeps an argument", () =>
    hegel.test((tc) => {
      const name = tc.draw(program);
      const args = tc.draw(gs.arrays(argument, { maxSize: 5 }));
      const call = tc.draw(gs.sampledFrom(["exec", "execSync", "spawn", "spawnSync", "execFile", "execFileSync", "fork", "shell"] as const));
      const detail =
        call === "exec" || call === "execSync"
          ? childProcessDetail(call, [[name, ...args.map(quoted)].join(" "), () => undefined])
          : call === "shell"
            ? childProcessDetail("spawn", [[name, ...args.map(quoted)].join(" "), { shell: true }])
            : childProcessDetail(call, [`/opt/tools/${name}`, args, {}]);
      expect(detail).not.toMatch(LEAKED);
      expect(detail).toBe(`${call === "shell" ? "spawn" : call} ${name} with ${args.length} ${args.length === 1 ? "argument" : "arguments"}`);
    }));

  it("counts a shell line's words and the list a shell call also got", () => {
    expect(childProcessDetail("spawn", ["git push", ["--force"], { shell: "/bin/sh" }])).toBe("spawn git with 2 arguments");
    expect(childProcessDetail("execFile", [new URL("file:///usr/bin/env")])).toBe("execFile env with 0 arguments");
    expect(childProcessDetail("fork", ["./worker.js"])).toBe("fork worker.js with 0 arguments");
  });
});
