import { spawnSync } from "node:child_process";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { shellWord } from "../src/shell/shell-word.js";

// What a shell hands a command for a line nukadoko printed.
function argvAfterShell(line: string, shell = "sh"): string[] {
  const result = spawnSync(shell, ["-c", `printf '%s\\0' ${line}`], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.split("\0").slice(0, -1);
}

const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;

const shellText = gs.text({ maxSize: 12, alphabet: "aZ09 _./:=@%+,-'\"\\$`*?~!#&;|<>()[]{}\t\n\u00e9" });

describe("shellWord", () => {
  it("leaves a plain word as it is", () => {
    expect(["features/steps", "a.feature:12", "--env=staging", "user@host", "50%"].map(shellWord)).toEqual([
      "features/steps",
      "a.feature:12",
      "--env=staging",
      "user@host",
      "50%",
    ]);
  });

  it("single-quotes a word with a space, a quote, or nothing in it", () => {
    expect(["my features/steps", "it's", ""].map(shellWord)).toEqual(["'my features/steps'", "'it'\\''s'", "''"]);
  });

  it("single-quotes a word that starts with =, and leaves = later in a word bare", () => {
    expect(["=ls", "=", "a=b"].map(shellWord)).toEqual(["'=ls'", "'='", "a=b"]);
  });

  it("gives back the same words after a POSIX shell reads the joined line", () =>
    hegel.test(
      (tc) => {
        const words = tc.draw(gs.arrays(shellText, { minSize: 1, maxSize: 4 }));
        expect(argvAfterShell(words.map(shellWord).join(" "))).toEqual(words);
      },
      { testCases: 60 },
    ));

  it.skipIf(!hasZsh)("gives back the same word after zsh reads it", () =>
    hegel.test(
      (tc) => {
        // Mostly characters a word may hold bare, so a leading = is often the only thing to quote.
        const word = tc.draw(gs.oneOf(shellText, gs.text({ minSize: 1, maxSize: 6, alphabet: "=aZ09_./:-" })));
        expect(argvAfterShell(shellWord(word), "zsh")).toEqual([word]);
      },
      { testCases: 60 },
    ));
});
