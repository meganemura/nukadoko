import { existsSync } from "node:fs";
import path from "node:path";

// Responsibility: turn a `runCommand` call into what Node's `spawn` can
// start on Windows. Node's own lookup tries only `.com` and `.exe`, so a bare
// `npm` is not found, and since the April 2024 security releases Node refuses
// to start a `.cmd` or `.bat` file without a shell. Those two files are run
// through `cmd.exe /d /s /c` instead, with every argument quoted and escaped
// so that cmd.exe passes it through unchanged.
// It decides nothing on another platform: the caller asks only on win32.
//
// The escaping follows cross-spawn's, which execa and many test runners use:
// quote each argument as a C runtime would read it, then put a caret before
// every character cmd.exe treats specially. A shim under node_modules/.bin
// hands its `%*` to cmd.exe a second time, so its arguments get the carets
// twice.

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Passed to `spawn` as `windowsVerbatimArguments`: the arguments are
   * already quoted for cmd.exe, and Node must not quote them again. */
  verbatim: boolean;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** The value of `name` in a Windows environment, whose names ignore case. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((each) => each.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The file a bare command name starts on Windows: the first directory on
 * PATH holding the name with one of PATHEXT's extensions. A name with a
 * directory part or an extension is returned as given, and so is a name
 * that nothing on PATH holds, so that `spawn` reports it as not found.
 */
export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = existsSync,
): string {
  if (/[\\/]/.test(command) || path.win32.extname(command) !== "") return command;
  const exts = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").filter((ext) => ext !== "");
  const dirs = (envValue(env, "PATH") ?? "").split(";").filter((dir) => dir !== "");
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.win32.join(dir.replace(/^"(.*)"$/, "$1"), command + ext);
      if (exists(file)) return file;
    }
  }
  return command;
}

/** One argument, quoted so a C runtime reads it back unchanged, then with
 * cmd.exe's special characters escaped once, or twice for a shim. */
export function quoteForCmd(arg: string, twice: boolean): string {
  // Backslashes before a quote, and before the closing quote, are doubled.
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`.replace(CMD_META, "^$1");
  return twice ? quoted.replace(CMD_META, "^$1") : quoted;
}

/** How to start `command` with `args` on Windows. */
export function windowsSpawnPlan(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = existsSync,
): SpawnPlan {
  const file = resolveWindowsCommand(command, env, exists);
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args: [...args], verbatim: false };
  const twice = CMD_SHIM.test(file);
  const line = [file.replace(CMD_META, "^$1"), ...args.map((arg) => quoteForCmd(arg, twice))].join(" ");
  return {
    file: envValue(env, "COMSPEC") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}
