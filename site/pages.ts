// Which page of the site each part of the repository's documents becomes, and where the
// page sits in the sidebar. The documents stay the one source: scripts/sync.ts cuts them
// into pages by their `## ` headings and never adds a fact of its own. A page names its
// sections by position, because the Japanese file translates the heading text but keeps
// the same headings in the same order.

/** One document, in English and its Japanese pair, relative to the repository root. */
export interface Source {
  en: string;
  ja: string;
}

export const sources = {
  readme: { en: "README.md", ja: "README.ja.md" },
  adopting: { en: "docs/adopting.md", ja: "docs/adopting.ja.md" },
  guide: { en: "docs/guide.md", ja: "docs/guide.ja.md" },
  intent: { en: "docs/intent.md", ja: "docs/intent.ja.md" },
  ci: { en: "docs/ci.md", ja: "docs/ci.ja.md" },
  migration: { en: "docs/typescript/migration.md", ja: "docs/typescript/migration.ja.md" },
  migrationPlaywright: { en: "docs/typescript/migration-playwright-test.md", ja: "docs/typescript/migration-playwright-test.ja.md" },
  executionEvents: { en: "docs/execution-events.md", ja: "docs/execution-events.ja.md" },
  spec: { en: "docs/spec.md", ja: "docs/spec.ja.md" },
  upgrading: { en: "docs/typescript/upgrading.md", ja: "docs/typescript/upgrading.ja.md" },
  ruby: { en: "ruby/README.md", ja: "ruby/README.ja.md" },
  rubyReference: { en: "docs/ruby/reference.md", ja: "docs/ruby/reference.ja.md" },
  typescriptReference: { en: "docs/typescript/reference.md", ja: "docs/typescript/reference.ja.md" },
} satisfies Record<string, Source>;

export type SourceName = keyof typeof sources;

/**
 * A page made of one document. `sections` lists the `## ` sections it takes, counted from
 * 0; without it the page is the whole document. `intro` takes the text before the first
 * `## ` too. A page that takes sections gets its title from the first one, and its other
 * sections stay `## ` headings; a whole document gets its title from its `# ` heading.
 */
export interface Page {
  slug: string;
  source: SourceName;
  sections?: number[];
  intro?: boolean;
  /** The title, when the document's own heading would not name the page well. */
  title?: { en: string; ja: string };
}

export interface Group {
  label: { en: string; ja: string };
  pages: Page[];
  collapsed?: boolean;
}


/** The home page: the README's opening, before its first `## `. */
export const home: Page = {
  slug: "index",
  source: "readme",
  sections: [],
  intro: true,
  title: { en: "nukadoko", ja: "nukadoko" },
};

export const groups: Group[] = [
  {
    label: { en: "Start", ja: "はじめに" },
    pages: [
      { slug: "why", source: "readme", sections: [0], title: { en: "Why nukadoko", ja: "なぜ nukadoko か" } },
      { slug: "install", source: "readme", sections: [1], title: { en: "Install", ja: "インストール" } },
      { slug: "first-scenario", source: "readme", sections: [2, 5], title: { en: "A first scenario", ja: "最初の scenario" } },
      { slug: "adopting", source: "adopting" },
    ],
  },
  {
    label: { en: "Use it", ja: "使い方" },
    pages: [
      { slug: "judging", source: "readme", sections: [3, 4], title: { en: "How a run is judged", ja: "run はどう判定されるか" } },
      { slug: "guide", source: "guide" },
      { slug: "intent", source: "intent" },
      { slug: "ci", source: "ci" },
      { slug: "agents", source: "readme", sections: [6, 7, 10], title: { en: "Agents and skills", ja: "エージェントと skill" } },
      { slug: "limits", source: "readme", sections: [9], title: { en: "What this does not do", ja: "nukadoko がしないこと" } },
      { slug: "ruby", source: "ruby" },
    ],
  },
  {
    label: { en: "Coming from another runner", ja: "ほかのツールから移る" },
    pages: [
      { slug: "migrating", source: "readme", sections: [8], title: { en: "Coming from cucumber-js or Playwright Test", ja: "cucumber-js や Playwright Test から" } },
      { slug: "migration", source: "migration" },
      { slug: "migration-playwright-test", source: "migrationPlaywright" },
    ],
  },
  {
    label: { en: "Reference", ja: "リファレンス" },
    pages: [
      { slug: "reference/ruby", source: "rubyReference" },
      { slug: "reference/typescript", source: "typescriptReference" },
      { slug: "reference/cli", source: "spec", sections: [15] },
      { slug: "reference/steps", source: "spec", sections: [3] },
      { slug: "reference/program", source: "spec", sections: [6] },
      { slug: "reference/running", source: "spec", sections: [7] },
      { slug: "reference/records", source: "spec", sections: [8] },
      { slug: "reference/environments", source: "spec", sections: [9] },
      { slug: "reference/review", source: "spec", sections: [10] },
      { slug: "reference/checks", source: "spec", sections: [14] },
      { slug: "reference/allure", source: "spec", sections: [11] },
      { slug: "reference/messages", source: "spec", sections: [12] },
      { slug: "reference/execution-events", source: "executionEvents" },
      { slug: "reference/compat", source: "spec", sections: [4] },
      { slug: "reference/playwright-test", source: "spec", sections: [5] },
      { slug: "reference/limits", source: "spec", sections: [16] },
    ],
  },
  {
    label: { en: "Design", ja: "設計" },
    collapsed: true,
    pages: [
      { slug: "design/overview", source: "spec", sections: [0, 1, 2], intro: true },
      { slug: "design/self-healing", source: "spec", sections: [13] },
      { slug: "design/roadmap", source: "spec", sections: [17] },
      { slug: "design/implementation", source: "spec", sections: [18] },
    ],
  },
  {
    label: { en: "Upgrading", ja: "アップグレード" },
    pages: [{ slug: "upgrading", source: "upgrading" }],
  },
];

/**
 * Sections no page takes, on purpose. The build fails on a section that is neither on a
 * page nor here, so a new `## ` in a document has to be placed.
 */
export const leftOut: Partial<Record<SourceName, number[]>> = {
  // Status, Where to go next, Design, License: the sidebar and the links on each page do their work.
  readme: [11, 12, 13, 14],
};

/** Documents of docs/ that are not about using nukadoko, so the site leaves them out. */
export const leftOutFiles = ["docs/releasing.md", "docs/releasing.ja.md"];

export const allPages: Page[] = [home, ...groups.flatMap((g) => g.pages)];
