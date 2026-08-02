import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka skill path`/`nuka skill install` (docs/spec.md "CLI
// summary", M5 roadmap slice A). `path` is the primary verb: which agent
// harness a user runs is theirs to choose, not nukadoko's, so the package
// only ever commits to naming where its own skill sources live on disk.
// `install` exists purely as a convenience default for the one harness this
// project itself develops against (Claude Code's `.claude/skills/<name>/`
// layout) — anyone using a different harness is expected to read the path
// `path` prints and place it themselves.
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

export const SKILL_NAME = "nukadoko-acceptance";

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

export interface RunSkillInstallOptions {
  rootDir: string;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runSkillInstall(options: RunSkillInstallOptions): Promise<number> {
  const { rootDir, stdout, stderr } = options;
  const sourceDir = acceptanceSkillDir();

  if (!existsSync(sourceDir)) {
    stderr.write(
      `nuka skill: skill source not found at ${sourceDir} (a packaging bug, not a project issue)\n`,
    );
    return 1;
  }

  const destDir = path.join(rootDir, ".claude", "skills", SKILL_NAME);

  // Refuse rather than overwrite: an existing directory here may hold a
  // user's own edits to the skill, and nukadoko has no way to tell the two
  // apart, so it never gets to decide that overwriting is safe.
  if (existsSync(destDir)) {
    stderr.write(
      `nuka skill: ${path.relative(rootDir, destDir)} already exists — refusing to overwrite it. Remove it yourself first, or place the skill by hand from \`nuka skill path\`.\n`,
    );
    return 1;
  }

  await mkdir(path.dirname(destDir), { recursive: true });
  await cp(sourceDir, destDir, { recursive: true });

  stdout.write(`${path.relative(rootDir, destDir)}\n`);
  return 0;
}
