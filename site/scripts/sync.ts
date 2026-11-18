// Writes the site's pages from the repository's own documents, as pages.ts places them:
// src/content/docs/ for English and src/content/docs/ja/ for Japanese, both ignored by git.
// It refuses to write anything when a document's sections are not all placed, when the
// Japanese pair cuts into a different number of sections, or when a link points at a
// heading no page holds. Run it before `astro build`; `npm run build` does.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { allPages, leftOut, leftOutFiles, sources, type Page, type SourceName } from "../pages.ts";
import { headingsOf, joinJapaneseLines, wrapEngineBlocks, parseDocument, plainText, rewriteLinks, shiftHeadings, type Document } from "./document.ts";

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(siteDir, "..");
const contentDir = join(siteDir, "src/content/docs");
const base = "/nukadoko";
const github = "https://github.com/meganemura/nukadoko";

type Locale = "en" | "ja";
const locales: Locale[] = ["en", "ja"];

class Refusal extends Error {}

function refuse(where: string, because: string, todo: string): never {
  throw new Refusal(`${where}\n  because: ${because}\n  do: ${todo}`);
}

const docs = new Map<string, Document>();
for (const name of Object.keys(sources) as SourceName[]) {
  for (const locale of locales) {
    const path = sources[name][locale];
    docs.set(path, parseDocument(readFileSync(join(repoDir, path), "utf8")));
  }
}

checkPlacement();

/** Where a heading of a source file lands: the page, and the id the page gives it. */
interface Landing {
  page: Page;
  /** Absent when the heading is the page's own title. */
  id?: string;
}

const landings = new Map<string, Map<string, Landing>>();
for (const [path, doc] of docs) landings.set(path, landingsOf(path, doc));

rmSync(contentDir, { recursive: true, force: true });
for (const page of allPages) {
  for (const locale of locales) {
    const file = join(contentDir, locale === "ja" ? "ja" : "", `${page.slug}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, render(page, locale));
  }
}
mkdirSync(join(siteDir, "public"), { recursive: true });
cpSync(join(repoDir, "llms.txt"), join(siteDir, "public/llms.txt"));
console.log(`sync: ${allPages.length} pages in ${locales.length} languages`);

function sourcePath(page: Page, locale: Locale): string {
  return sources[page.source][locale];
}

/** The sections a page takes, or every section when it takes the whole document. */
function sectionsOf(page: Page, doc: Document): number[] {
  return page.sections ?? doc.sections.map((_, i) => i);
}

function takesIntro(page: Page): boolean {
  return page.sections === undefined || page.intro === true;
}

/** Each source's sections are on exactly one page or left out, and both languages agree. */
function checkPlacement(): void {
  for (const file of readdirSync(join(repoDir, "docs"))) {
    const path = `docs/${file}`;
    if (!file.endsWith(".md") || leftOutFiles.includes(path)) continue;
    if (!docs.has(path)) refuse(path, "no page of the site takes this document", `place it in site/pages.ts, or name it in leftOutFiles`);
  }
  for (const name of Object.keys(sources) as SourceName[]) {
    const { en, ja } = sources[name];
    const enCount = docs.get(en)!.sections.length;
    const jaCount = docs.get(ja)!.sections.length;
    if (enCount !== jaCount) {
      refuse(ja, `it has ${jaCount} \`## \` sections and ${en} has ${enCount}, so the site cannot pair their pages`, `give ${ja} the same \`## \` headings in the same order as ${en}`);
    }
    const placed = new Map<number, string>();
    for (const page of allPages.filter((p) => p.source === name)) {
      for (const i of sectionsOf(page, docs.get(en)!)) {
        if (i >= enCount) refuse(`site/pages.ts ${page.slug}`, `${en} has no section ${i}; it has ${enCount}`, "count the `## ` headings from 0");
        if (placed.has(i)) refuse(`site/pages.ts ${page.slug}`, `section ${i} of ${en} is on ${placed.get(i)} already`, "give each section one page");
        placed.set(i, page.slug);
      }
    }
    for (const i of leftOut[name] ?? []) placed.set(i, "leftOut");
    for (let i = 0; i < enCount; i++) {
      if (!placed.has(i)) {
        refuse(`${en} "## ${docs.get(en)!.sections[i].heading}"`, "no page of the site takes this section", "add it to a page in site/pages.ts, or to leftOut");
      }
    }
  }
}

/** Every heading of a source file, by the id GitHub gives it, mapped to where it lands. */
function landingsOf(path: string, doc: Document): Map<string, Landing> {
  const locale: Locale = path.endsWith(".ja.md") ? "ja" : "en";
  const name = (Object.keys(sources) as SourceName[]).find((n) => sources[n][locale] === path)!;
  const fileSlugger = new GithubSlugger();
  const map = new Map<string, Landing>();
  const pageOfSection = new Map<number, Page>();
  let introPage: Page | undefined;
  for (const page of allPages.filter((p) => p.source === name)) {
    for (const i of sectionsOf(page, doc)) pageOfSection.set(i, page);
    if (takesIntro(page)) introPage = page;
  }
  const pageSluggers = new Map<Page, GithubSlugger>();
  const idOnPage = (page: Page, text: string) => {
    if (!pageSluggers.has(page)) pageSluggers.set(page, new GithubSlugger());
    return pageSluggers.get(page)!.slug(text);
  };
  if (doc.title !== undefined) {
    const id = fileSlugger.slug(plainText(doc.title));
    if (introPage) map.set(id, { page: introPage });
  }
  for (const heading of headingsOf(doc.intro)) {
    const id = fileSlugger.slug(plainText(heading.text));
    if (introPage) map.set(id, { page: introPage, id: idOnPage(introPage, plainText(heading.text)) });
  }
  doc.sections.forEach((section, i) => {
    const page = pageOfSection.get(i);
    const id = fileSlugger.slug(plainText(section.heading));
    const isTitle = page !== undefined && page.sections !== undefined && page.sections[0] === i && !takesIntro(page);
    if (page) map.set(id, isTitle ? { page } : { page, id: idOnPage(page, plainText(section.heading)) });
    for (const heading of headingsOf(section.lines)) {
      const sub = fileSlugger.slug(plainText(heading.text));
      if (page) map.set(sub, { page, id: idOnPage(page, plainText(heading.text)) });
    }
  });
  return map;
}

function pageUrl(page: Page, locale: Locale): string {
  const slug = page.slug === "index" ? "" : `${page.slug}/`;
  return `${base}/${locale === "ja" ? "ja/" : ""}${slug}`;
}

/** The page a link to a whole document opens: the one with its opening text, else its first. */
function pageOfDocument(path: string): Page {
  const locale: Locale = path.endsWith(".ja.md") ? "ja" : "en";
  const name = (Object.keys(sources) as SourceName[]).find((n) => sources[n][locale] === path)!;
  const pages = allPages.filter((p) => p.source === name);
  return pages.find(takesIntro) ?? pages[0];
}

function rewriteTarget(target: string, from: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  const [pathPart, hash] = target.split("#", 2) as [string, string | undefined];
  const repoPath = pathPart === "" ? from : posix.normalize(posix.join(posix.dirname(from), pathPart));
  if (repoPath.startsWith("..")) refuse(`${from} link ${target}`, "it points outside the repository", "link to a file inside the repository, or to a full URL");
  const map = landings.get(repoPath);
  const locale: Locale = repoPath.endsWith(".ja.md") ? "ja" : "en";
  if (map === undefined) {
    const full = join(repoDir, repoPath);
    if (!existsSync(full)) refuse(`${from} link ${target}`, `${repoPath} does not exist`, "fix the link in the document");
    const kind = statSync(full).isDirectory() ? "tree" : "blob";
    return `${github}/${kind}/main/${repoPath}${hash ? `#${hash}` : ""}`;
  }
  if (!hash) return pageUrl(pageOfDocument(repoPath), locale);
  const landing = map.get(hash);
  if (landing === undefined) {
    // A heading in a section the site leaves out still exists on GitHub.
    const known = headingIds(repoPath).has(hash);
    if (known) return `${github}/blob/main/${repoPath}#${hash}`;
    refuse(`${from} link ${target}`, `${repoPath} has no heading whose id is "${hash}"`, "fix the anchor in the document; GitHub gives a heading the id of its lowercase text, spaces as hyphens");
  }
  return pageUrl(landing.page, locale) + (landing.id ? `#${landing.id}` : "");
}

function headingIds(path: string): Set<string> {
  const doc = docs.get(path)!;
  const slugger = new GithubSlugger();
  const all = [...(doc.title === undefined ? [] : [doc.title]), ...headingsOf(doc.intro).map((h) => h.text)];
  for (const section of doc.sections) all.push(section.heading, ...headingsOf(section.lines).map((h) => h.text));
  return new Set(all.map((text) => slugger.slug(plainText(text))));
}

function render(page: Page, locale: Locale): string {
  const path = sourcePath(page, locale);
  const doc = docs.get(path)!;
  const picked = sectionsOf(page, doc);
  let title: string;
  let lines: string[] = [];
  if (takesIntro(page)) {
    title = page.title?.[locale] ?? plainText(doc.title ?? path);
    lines.push(...doc.intro);
    for (const i of picked) lines.push(`## ${doc.sections[i].heading}`, ...doc.sections[i].lines);
  } else {
    const [first, ...rest] = picked;
    title = page.title?.[locale] ?? plainText(doc.sections[first].heading);
    if (rest.length === 0) {
      // The page is one section: its `### ` headings become the page's top level.
      lines = shiftHeadings(doc.sections[first].lines, -1);
    } else {
      lines.push(...doc.sections[first].lines);
      for (const i of rest) lines.push(`## ${doc.sections[i].heading}`, ...doc.sections[i].lines);
    }
  }
  // The Japanese README keeps the English heading and puts its translation in bold on the
  // first line; the page title is that translation already, so the line would repeat it.
  const firstText = lines.findIndex((line) => line.trim() !== "");
  if (firstText >= 0 && lines[firstText].trim() === `**${title}**`) lines.splice(firstText, 1);
  lines = rewriteLinks(lines, (target) => rewriteTarget(target, path));
  if (locale === "ja") lines = joinJapaneseLines(lines);
  lines = wrapEngineBlocks(lines);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `editUrl: ${JSON.stringify(`${github}/edit/main/${path}`)}`,
    "---",
    "",
    `<!-- Written by site/scripts/sync.ts from ${path}. Edit that file. -->`,
  ];
  return [...frontmatter, ...lines].join("\n").replace(/\n*$/, "\n");
}
