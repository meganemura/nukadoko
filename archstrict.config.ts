import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its own surface file (named by `surface` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - common noise directories that init found on disk (tests, examples).
  //   Remove one of these entries if that directory holds module content.
  // - colocated test files, found on disk (*.test.ts, *.spec.ts).
  //   A test file imports across modules as a fixture; boundary rules read production code.
  //   Remove both matching entries below (root and nested form) if that file must stay analyzed.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "tests/**",
    "examples/**",
    "*.test.ts",
    "**/*.test.ts",
    "*.spec.ts",
    "**/*.spec.ts",
    // Not the library this package publishes. vscode/ is its own package,
    // selftest-suite/ is the harness, and a root *.ts file is tooling.
    "selftest-suite/**",
    "vscode/**",
    "*.ts",
  ],
  // init's per-directory modules were collapsed onto the package exports.
  // "." compiles from src/index.ts, so everything under src/ that is not a
  // subpath export is one module, core, and that file is its surface
  // (surface left unset: these directories have no package.json of their
  // own, so the project default index.ts is the entry each export builds).
  // The three subpath exports are their own modules. A more specific glob
  // wins, so files under those directories are not also core.
  // After an edit, run archstrict init to regenerate archstrict.types.ts.
  declaredModules: [
    { name: "core", glob: "src/**" },
    { name: "compat", glob: "src/compat/**" },
    { name: "matching", glob: "src/matching/**" },
    { name: "mcp", glob: "src/mcp/**" },
  ],
  because: "package exports are the boundaries: core is the root export, and compat, matching, and mcp are the three subpath exports",
} satisfies Config;
