// Responsibility: after `tsc -p tsconfig.build.json`, make every emitted
// declaration file that names `playwright` compile in a project that has not
// installed it. Boundary: rewrites `dist/**/*.d.ts` and the `.d.ts.map` beside
// each one, and nothing else; the JavaScript and `src/` are untouched.
//
// `playwright` is an optional peer, so a project without a browser step does
// not install it, and `nuka init` puts that project's step files into its own
// `tsc`. Those files import `nukadoko`, which pulls these declarations in, and
// under `skipLibCheck: false` every `import type ... from "playwright"` in them
// is TS2307. A `// @ts-ignore` on the line before turns each such import into
// `any` when the module is missing, and changes nothing when it is installed,
// so a project with Playwright keeps `Page` and the rest. Declaration emit
// drops that comment when it is written in the source, which is why it is
// added here, after emit, rather than in `src/`.
//
// Each inserted line shifts the lines below it, so the matching declaration
// map gets an empty line at the same place: Go to Definition from a `.d.ts`
// still lands on the source line that produced it.
//
// Run directly by Node (type stripping), so erasable syntax only and no
// relative imports.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIRECTIVE = "// @ts-ignore optional peer: resolves to any when playwright is absent";

// A module specifier position: `from "playwright"`, `import "playwright"`, or
// `import("playwright")`, with or without a subpath. A string that only
// mentions the word elsewhere in a line is not a reference.
const SPECIFIER_REFERENCE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])playwright(?:\/[^"'\n]*)?\1/;

export function referencesPlaywright(line: string): boolean {
  return SPECIFIER_REFERENCE.test(line);
}

export interface GuardedLines {
  readonly lines: string[];
  // Indexes into the input of the lines a directive was inserted before, in
  // ascending order.
  readonly insertedBefore: number[];
}

// Idempotent: a reference already preceded by the directive gets no second
// one, so running the build twice over the same `dist/` changes nothing.
export function guardLines(input: readonly string[]): GuardedLines {
  const lines: string[] = [];
  const insertedBefore: number[] = [];
  input.forEach((line, index) => {
    const previous = lines[lines.length - 1];
    if (referencesPlaywright(line) && previous?.trim() !== DIRECTIVE) {
      lines.push(`${/^\s*/.exec(line)?.[0] ?? ""}${DIRECTIVE}`);
      insertedBefore.push(index);
    }
    lines.push(line);
  });
  return { lines, insertedBefore };
}

// Source map v3 `mappings` separates generated lines with `;`, and a
// segment's source line and column are relative to the previous segment
// across lines, so an inserted line with no segments shifts every later line
// by one and alters no segment.
export function shiftMappings(mappings: string, insertedBefore: readonly number[]): string {
  const generated = mappings.split(";");
  for (const index of [...insertedBefore].reverse()) {
    if (index < generated.length) generated.splice(index, 0, "");
  }
  return generated.join(";");
}

async function declarationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".d.ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

export async function guardTree(dir: string): Promise<string[]> {
  const changed: string[] = [];
  for (const file of await declarationFiles(dir)) {
    const { lines, insertedBefore } = guardLines((await readFile(file, "utf8")).split("\n"));
    if (insertedBefore.length === 0) continue;
    await writeFile(file, lines.join("\n"));
    const mapFile = `${file}.map`;
    const map = JSON.parse(await readFile(mapFile, "utf8")) as { mappings: string };
    map.mappings = shiftMappings(map.mappings, insertedBefore);
    await writeFile(mapFile, JSON.stringify(map));
    changed.push(file);
  }
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? "dist");
  const changed = await guardTree(dir);
  if (changed.length === 0) {
    process.stderr.write(`guard-playwright-types: no declaration under ${dir} imports playwright\n`);
  }
}
