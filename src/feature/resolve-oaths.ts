import { readdirSync, statSync } from "node:fs";
import path from "node:path";

// Responsibility: turn `config.oaths` into the Markdown files `nuka check`,
// `nuka tend`, and a directory `nuka run` should read. A named file is
// that file. A named directory is every `*.md` under it, except
// `node_modules` and dot-directories (the same places step discovery
// refuses to walk: a wide directory must not pull in dependencies or the
// state directory). Nothing here parses an oath. A missing path or a
// path that is neither a `.md` file nor a directory is a problem string
// the caller reports; this function does not throw, so one bad entry
// does not hide the files that do exist.

export interface OathPathProblem {
  readonly path: string;
  readonly message: string;
}

export interface ResolvedOaths {
  /** Root-relative `.md` paths, de-duplicated, byte order. */
  readonly files: readonly string[];
  readonly problems: readonly OathPathProblem[];
}

/** A path `nuka check` / `nuka run` was given is an oath when it names a
 * Markdown file. The check is the extension only: listing the file in
 * `oaths` is what selects it for a scan that was not pointed at it. */
export function isOathPath(relativePath: string): boolean {
  return relativePath.endsWith(".md");
}

export function resolveOathPaths(rootDir: string, oaths: readonly string[]): ResolvedOaths {
  const files: string[] = [];
  const problems: OathPathProblem[] = [];
  const seen = new Set<string>();

  const addFile = (relativePath: string): void => {
    if (seen.has(relativePath)) {
      return;
    }
    seen.add(relativePath);
    files.push(relativePath);
  };

  for (const entry of oaths) {
    const absolute = path.resolve(rootDir, entry);
    const relative = path.relative(rootDir, absolute);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      problems.push({ path: entry, message: `oaths names "${entry}", which does not exist` });
      continue;
    }
    if (stat.isDirectory()) {
      for (const file of walkMarkdownFiles(absolute)) {
        addFile(path.relative(rootDir, file));
      }
      continue;
    }
    if (!stat.isFile() || !isOathPath(relative)) {
      problems.push({
        path: entry,
        message: `oaths names "${entry}", which is not a Markdown file or a directory`,
      });
      continue;
    }
    addFile(relative);
  }

  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files, problems };
}

function walkMarkdownFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}
