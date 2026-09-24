# ADOPTION_PAIN — nukadoko (rocky local dogfood)

Date: 2026-09-24 (JST)

## Setup
- Worktree: `nukadoko-archstrict-adopt` from `origin/main`
- Install: `file:../archstrict` (local unpublished)
- Result: `npx archstrict check` exit 0; `todo` firstRun with 0 freezable debt

## Frictions

### 1. Init multi-module preset vs first-operational goal (related archstrict-4fq)
`init 'src/*'` correctly found 24 subdirectories under `src/` and declared each as a module. Most have no `index.ts`. First operational adopt collapsed to one `src/**` module instead of freezing a large public-surface-bypass debt across 24 modules. Package exports (`compat`/`matching`/`mcp`) are natural later boundaries.

### 2. Whole-tree noise without excludes (archstrict-4fq)
`tests/`, `examples/`, `selftest-suite/`, `vscode/` need explicit exclude.

### 3. Hand-edited ModuleName (archstrict-re9)
Collapsed `declaredModules` to one name; patched `ModuleName` from the 24-way union to `"nukadoko"`.

## What made it operational
- `exclude`: tests/examples/selftest-suite/vscode/dist/coverage/scripts/features/fixtures + root `*.ts`
- Single module `{ name: "nukadoko", glob: "src/**", surface: "index.ts" }` (real `src/index.ts` exists)
- Patched `ModuleName` to `"nukadoko"`
