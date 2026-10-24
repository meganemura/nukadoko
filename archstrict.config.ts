import type { Config } from "./archstrict.types.js";

// Module boundaries follow how this package grows.
//
// The step contract is split into five layers with no cycle between
// them: records, the step contract itself (step definitions, the ctx
// types, fixture types), config, the context that builds ctx, and
// fixtures. Every module is a directory module with the files other
// modules already import as its surface.
// A new file stays private until a caller outside the module needs it,
// which is the moment the surface has to be updated on purpose.
//
// Layers run from the leaves up to the two process entries. A layer may
// depend on an earlier one. Checks, the runner, compat, and matching are
// not one module, so a change in one of them is not a change to all of
// them.
//
// After an edit here, run `archstrict init` to regenerate archstrict.types.ts.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
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
    // Not the library this package publishes. selftest-suite/ is the
    // harness, and a root *.ts file and scripts/ are tooling.
    "selftest-suite/**",
    "*.ts",
    "scripts/**",
  ],
  mustBeEmpty: [
    {
      glob: "src/core/**",
      because:
        "there is no mega-core directory. A new check, matcher, compat file, or command goes in its own module.",
    },
    {
      glob: "src/utils/**",
      because:
        "a utils directory becomes the next mega-core. A shared function gets a named module (sink, issues, env, shell) instead.",
    },
    {
      glob: "src/shared/**",
      because:
        "a shared directory hides which seam a change belongs to. Name the module for the thing it is.",
    },
  ],
  // Leaves and package doors that should not accumulate frozen debt.
  // A bypass here is fixed by extending that module's surface, not by
  // writing it into the todo file.
  strict: ["binding", "check", "compat", "entry", "env", "feature", "finding", "issues", "matching", "shell", "sink", "stored-form", "version"],
  classify: [
    { glob: "src/env/**", tags: ["layer:leaf", "pkghost:library"] },
    { glob: "src/finding/**", tags: ["layer:leaf", "pkghost:library"] },
    { glob: "src/issues/**", tags: ["layer:leaf", "pkghost:library"] },
    { glob: "src/shell/**", tags: ["layer:leaf", "pkghost:library"] },
    { glob: "src/stored-form/**", tags: ["layer:leaf", "pkghost:library"] },
    { glob: "src/binding/**", tags: ["layer:base", "pkghost:library"] },
    { glob: "src/compat/**", tags: ["layer:base", "pkghost:library"] },
    { glob: "src/secrets/**", tags: ["layer:base", "pkghost:library"] },
    { glob: "src/sink/**", tags: ["layer:base", "pkghost:library"] },
    { glob: "src/record/**", tags: ["layer:record", "pkghost:library"] },
    { glob: "src/step/**", tags: ["layer:contract", "pkghost:library"] },
    { glob: "src/config/**", tags: ["layer:config", "pkghost:library"] },
    { glob: "src/context/**", tags: ["layer:context", "pkghost:library"] },
    { glob: "src/fixture/**", tags: ["layer:fixture", "pkghost:library"] },
    { glob: "src/discover/**", tags: ["layer:read", "pkghost:library"] },
    { glob: "src/feature/**", tags: ["layer:read", "pkghost:feature"] },
    { glob: "src/version.ts", tags: ["layer:read", "pkghost:library"] },
    { glob: "src/check/**", tags: ["layer:service", "pkghost:library"] },
    { glob: "src/environment/**", tags: ["layer:service", "pkghost:library"] },
    { glob: "src/report/**", tags: ["layer:service", "pkghost:library"] },
    { glob: "src/run/**", tags: ["layer:run", "pkghost:library"] },
    { glob: "src/cli/**", tags: ["layer:adapter", "pkghost:cli"] },
    { glob: "src/cli.ts", tags: ["layer:entry", "pkghost:cli"] },
    { glob: "src/index.ts", tags: ["layer:entry", "pkghost:library"] },
    { glob: "src/matching/**", tags: ["layer:entry", "pkghost:library"] },
  ],
  edges: {
    order: [
      {
        tagNamespace: "layer",
        sequence: {
          "": ["leaf", "base", "record", "contract", "config", "context", "fixture", "read", "service", "run", "adapter", "entry"],
        },
        direction: "downward-only",
        because:
          "foundation first. Records sit under the step contract, then config, the context that builds ctx, and fixtures. Checks, the runner, and matching sit above all five, so a change in one of them does not reach back into a lower layer. compat sits below them in base, so the migration door never depends on the engine it is migrating into.",
      },
    ],
    allowDeny: [
      {
        source: "pkghost:library",
        targetNamespace: "pkg",
        deny: ["yargs", "@cucumber/gherkin"],
        because:
          "yargs and the Gherkin parser each have one home. Library code does not grow a second one.",
      },
      {
        source: "pkghost:cli",
        targetNamespace: "pkg",
        deny: ["@cucumber/gherkin"],
        because:
          "the CLI may parse argv with yargs. Feature files are parsed by the feature module.",
      },
      {
        source: "pkghost:feature",
        targetNamespace: "pkg",
        deny: ["yargs"],
        because:
          "feature is the only module that links @cucumber/gherkin. It does not parse argv.",
      },
    ],
  },
  declaredModules: [
    { name: "env", glob: "src/env/**", surface: ["load-env-files.ts", "parse-env-file.ts"] },
    { name: "finding", glob: "src/finding/**", surface: ["finding.ts", "run-codes.ts"] },
    { name: "issues", glob: "src/issues/**", surface: ["format-issues.ts"] },
    { name: "shell", glob: "src/shell/**", surface: ["shell-word.ts"] },
    { name: "stored-form", glob: "src/stored-form/**", surface: ["revive.ts", "stored-form.ts"] },
    {
      name: "binding",
      glob: "src/binding/**",
      surface: [
        "capture.ts",
        "errors.ts",
        "escape-hint.ts",
        "expression.ts",
        "parameter-type-config.ts",
        "parameter-type-errors.ts",
        "pattern.ts",
        "quote-hint.ts",
        "registry.ts",
        "schema-shape.ts",
      ],
    },
    {
      name: "compat",
      glob: "src/compat/**",
      surface: [
        "allure-runtime.ts",
        "data-table.ts",
        "declared.ts",
        "define-world.ts",
        "errors.ts",
        "hooks.ts",
        "index.ts",
        "registry.ts",
        "run-hooks.ts",
        "tag-expression.ts",
        "world.ts",
      ],
    },
    {
      name: "secrets",
      glob: "src/secrets/**",
      surface: ["build-secret-set.ts", "classify-env-files.ts", "redact.ts", "types.ts"],
    },
    { name: "sink", glob: "src/sink/**", surface: ["writable-sink.ts"] },
    {
      name: "config",
      glob: "src/config/**",
      surface: [
        "config-presence.ts",
        "define-config.ts",
        "errors.ts",
        "import-failure.ts",
        "load-config.ts",
        "module-kind.ts",
        "schema.ts",
        "ts-loader.ts",
      ],
    },
    {
      name: "context",
      glob: "src/context/**",
      surface: [
        "create-context.ts",
        "env.ts",
        "errors.ts",
        "evidence.ts",
        "load-playwright.ts",
        "poll.ts",
        "run-command.ts",
        "run-server.ts",
        "trace-actions.ts",
        "used.ts",
      ],
    },
    {
      name: "fixture",
      glob: "src/fixture/**",
      surface: ["define-fixtures.ts", "graph.ts", "resolver.ts", "step-needs.ts", "validate-fixtures.ts"],
    },
    {
      name: "record",
      glob: "src/record/**",
      surface: [
        "contained-path.ts",
        "newest-run.ts",
        "read-step-record.ts",
        "record-id.ts",
        "retention.ts",
        "run-exports.ts",
        "run-result.ts",
        "run-sources.ts",
        "scenario-record.ts",
        "schema-version.ts",
        "state-layout.ts",
        "types.ts",
        "write-step-record.ts",
      ],
    },
    {
      name: "step",
      glob: "src/step/**",
      surface: [
        "context.ts",
        "define-step.ts",
        "fixture-names.ts",
        "fixture-types.ts",
        "infer-needs.ts",
        "parse-returns.ts",
        "resolve-use.ts",
        "step-fixture-names.ts",
        "strict-args.ts",
        "validate-from.ts",
        "validate-parts.ts",
      ],
    },
    {
      name: "discover",
      glob: "src/discover/**",
      surface: ["discover-steps.ts", "format-vocabulary-error.ts"],
    },
    {
      name: "feature",
      glob: "src/feature/**",
      surface: ["feature-arg-read.ts", "load-features.ts"],
    },
    { name: "version", glob: "src/version.ts", surface: "version.ts" },
    {
      name: "check",
      glob: "src/check/**",
      surface: [
        "analyze.ts",
        "binding-check.ts",
        "codes.ts",
        "config-check.ts",
        "description-todo.ts",
        "done-callback.ts",
        "feature-check.ts",
        "from-order.ts",
        "playwright-check.ts",
        "types.ts",
        "unbound-patterned.ts",
        "unfillable-key.ts",
      ],
    },
    {
      name: "environment",
      glob: "src/environment/**",
      surface: ["name.ts", "probe-version.ts", "resolve-environment.ts"],
    },
    {
      name: "report",
      glob: "src/report/**",
      surface: [
        "allure/categories.ts",
        "allure/identity.ts",
        "allure/write-results.ts",
        "load-run.ts",
        "messages/write-stream.ts",
        "step-records.ts",
        "summary/hook-label.ts",
      ],
    },
    {
      name: "run",
      glob: "src/run/**",
      surface: [
        "criteria-since.ts",
        "execute-typed-step.ts",
        "git-since.ts",
        "match-step.ts",
        "probe-git.ts",
        "verdicts.ts",
        "process-signal.ts",
        "progress-log.ts",
        "repeated-prefix.ts",
        "run-concurrent.ts",
        "run-document.ts",
        "run-id.ts",
        "run-scenario.ts",
        "run-summary.ts",
        "select-pickles.ts",
        "step-stdout.ts",
      ],
    },
    { name: "cli", glob: "src/cli/**", surface: ["run-cli.ts"] },
    { name: "bin", glob: "src/cli.ts", surface: "cli.ts" },
    { name: "entry", glob: "src/index.ts", surface: "index.ts" },
    { name: "matching", glob: "src/matching/**" },
  ],
  because:
    "seams follow growth. The step contract is one module, layered between records below and config, context, and fixtures above. Checks, compat, matching, and the CLI are separate modules with explicit surfaces, so a new file in one of them does not land in a single core.",
} satisfies Config;
