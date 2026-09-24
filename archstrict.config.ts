import type { Config } from "./archstrict.types.js";

export default {
  schemaVersion: 1,
  surface: "index.ts",
  exclude: [
    "*.ts",
    "test/**",
    "tests/**",
    "example/**",
    "examples/**",
    "spike/**",
    "dist/**",
    "coverage/**",
    "scripts/**",
    "features/**",
    "fixtures/**",
    "selftest-suite/**",
    "vscode/**",
  ],
  classify: [{ glob: "src/**", tags: ["kind:lib"] }],
  // First operational adopt: one module for the whole library.
  // package exports (compat/matching/mcp) can become real modules later.
  declaredModules: [
    { name: "nukadoko", glob: "src/**", surface: "index.ts" },
  ],
  because: "nukadoko first adopt: single src module; exclude tests/examples/vscode/selftest",
} satisfies Config;
