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
    label: "Changelog",
    translations: { ja: "変更履歴" },
    link: "https://github.com/meganemura/nukadoko/blob/main/CHANGELOG.md",
    attrs: { target: "_blank" },
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
    }),
  ],
});
