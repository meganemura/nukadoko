// Checks the built site: every link to a page of the site opens a page that exists, and
// every `#id` names a heading on that page. sync.ts resolves links by its own reading of
// the headings; this reads what Astro actually wrote, so a difference between the two
// fails here instead of on a reader's click. Run it after `astro build`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const base = "/nukadoko/";

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? htmlFiles(path) : entry.name.endsWith(".html") ? [path] : [];
  });
}

const idsOf = new Map<string, Set<string>>();
function ids(file: string): Set<string> {
  if (!idsOf.has(file)) {
    const html = readFileSync(file, "utf8");
    idsOf.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]))));
  }
  return idsOf.get(file)!;
}

const broken: string[] = [];
for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, "utf8");
  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    if (!href.startsWith(base)) continue;
    const [path, hash] = href.slice(base.length).split("#", 2);
    if (/\.[a-z]+$/.test(path)) {
      if (!existsSync(join(dist, path))) broken.push(`${file.slice(dist.length + 1)} -> ${href} (no such file)`);
      continue;
    }
    const target = join(dist, path, "index.html");
    if (!existsSync(target)) broken.push(`${file.slice(dist.length + 1)} -> ${href} (no such page)`);
    else if (hash && !ids(target).has(decodeURIComponent(hash))) broken.push(`${file.slice(dist.length + 1)} -> ${href} (no such heading)`);
  }
}

if (broken.length > 0) {
  console.error(`${broken.length} broken links:\n${[...new Set(broken)].join("\n")}`);
  console.error("do: fix the link or the heading in the source document, then npm run build");
  process.exit(1);
}
console.log("check-links: every link to the site opens a page and a heading that exist");
