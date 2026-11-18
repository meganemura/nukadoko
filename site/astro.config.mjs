// The site of nukadoko's documentation: English at /nukadoko/, Japanese at /nukadoko/ja/.
// The sidebar is pages.ts read as it is, so a page and its place are named once.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { groups } from "./pages.ts";

const sidebar = [
  ...groups.map((group) => ({
    label: group.label.en,
    translations: { ja: group.label.ja },
    collapsed: group.collapsed ?? false,
    items: group.pages.map((page) => page.slug),
  })),
  {
    label: "Changelogs",
    translations: { ja: "変更履歴" },
    items: [
      { label: "Ruby (gem)", link: "https://github.com/meganemura/nukadoko/blob/main/ruby/CHANGELOG.md", attrs: { target: "_blank" } },
      { label: "TypeScript (npm)", link: "https://github.com/meganemura/nukadoko/blob/main/typescript/CHANGELOG.md", attrs: { target: "_blank" } },
    ],
  },
];

export default defineConfig({
  site: "https://meganemura.github.io",
  base: "/nukadoko",
  integrations: [
    starlight({
      title: "nukadoko",
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ja: { label: "日本語", lang: "ja" },
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/meganemura/nukadoko" }],
      sidebar,
      // Every page sets its own editUrl to the document it came from, so "Edit page"
      // opens the source rather than the generated copy.
      editLink: { baseUrl: "https://github.com/meganemura/nukadoko/edit/main/" },
      lastUpdated: false,
      components: { ThemeSelect: "./src/components/ThemeSelect.astro" },
      customCss: ["./src/styles/engines.css"],
      head: [
        {
          tag: "script",
          // Applies the reader's engine before the first paint; ThemeSelect.astro keeps it.
          content: "try{var e=localStorage.getItem(\"nukadoko-engine\");document.documentElement.dataset.engine=e===\"ruby\"||e===\"typescript\"?e:\"both\"}catch(_){document.documentElement.dataset.engine=\"both\"}",
        },
      ],
    }),
  ],
});
