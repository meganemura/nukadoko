import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka skill path` (docs/spec.md "CLI summary", M5 roadmap
// slice A). `path` is the only verb: printing where this package's own
// skill sources live on disk is a fact about the installed nukadoko, not a
// choice nukadoko should be making on a user's behalf.
//
// There used to be a `nuka skill install` here too, copying the skill into
// Claude Code's `.claude/skills/<name>/` layout. It was removed: `gh skill
// install` (GitHub CLI v2.90.0+) and Claude Code's own plugin marketplace
// already do that job — across every host the open Agent Skills
// specification targets, not just one — so a hand-rolled copier here was a
// single-host degraded third path with nothing `path` didn't already offer.
// `path` stays because it is the only route guaranteed to match the
// nukadoko version actually installed via npm: `gh skill install` and the
// plugin marketplace both fetch from wherever they're configured to, which
// need not be this exact version.
//
// Skill sources ship under `skills/` at the package root, not under
// `dist/`, and are resolved from *this file's own* `import.meta.url` rather
// than `process.cwd()` — an installing project only depends on nukadoko, it
// doesn't contain a copy of it. tsconfig.build.json mirrors `src/` onto
// `dist/` one-for-one (no path remapping), so this file lives at
// `<root>/src/cli/skill.ts` pre-build and `<root>/dist/cli/skill.js`
// post-build: two directories below `<root>` either way. Walking up two
// directories from this file's own URL therefore lands on the package root
// whether the process started via `npx tsx src/cli.ts` or `node
// dist/cli.js` — the two entry points this task's spec requires both work.

function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function acceptanceSkillDir(): string {
  return path.join(packageRoot(), "skills", "acceptance");
}

export interface RunSkillPathOptions {
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runSkillPath(options: RunSkillPathOptions): Promise<number> {
  const { stdout, stderr } = options;
  const dir = acceptanceSkillDir();

  if (!existsSync(dir)) {
    stderr.write(`nuka skill: skill source not found at ${dir} (a packaging bug, not a project issue)\n`);
    return 1;
  }

  stdout.write(`${dir}\n`);
  return 0;
}
