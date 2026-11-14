import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Generator } from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { judgedViewAttachments } from "../src/report/judged-view-files.js";
import { markdownLink, seenLinks } from "../src/report/summary/seen-links.js";
import type { JudgedPageView, JudgedView, JudgedViewFile } from "../src/record/types.js";
import { judgedViewForRun } from "../src/run/run-document.js";

// Responsibility: the pure parts of a claim step's `judged_view` as its
// readers get it. run.json names each file from the run directory by
// joining it to the step's record and changes nothing else
// (`judgedViewForRun`); the summary links every file once, page by page,
// a screenshot before its ARIA snapshot, and a Then that read no page its
// http.jsonl (`seenLinks`); a link's destination never ends its line
// (`markdownLink`); and Allure attaches every file once, under a name
// that tells pages apart (`judgedViewAttachments`).

const files = (extension: "png" | "aria.yml"): Generator<JudgedViewFile | null> =>
  gs.oneOf(
    gs.just(null),
    gs.composite((tc) => ({
      file: `judged/${tc.draw(gs.sampledFrom(["page", "page-2", "page.aki", "page-3.ben"]))}.${extension}`,
      after_reading_ms: tc.draw(gs.integers({ minValue: 0, maxValue: 5000 })),
    })),
  );

const pages: Generator<JudgedPageView> = gs.composite((tc) => ({
  as: tc.draw(gs.sampledFrom([null, "aki", "ben"])),
  page: tc.draw(gs.integers({ minValue: 1, maxValue: 4 })),
  url: tc.draw(gs.sampledFrom(["http://localhost:4100/", "http://aki.localhost:4100/room"])),
  title: tc.draw(gs.sampledFrom([null, "Cart", "Room"])),
  screenshot: tc.draw(files("png")),
  aria: tc.draw(files("aria.yml")),
}));

const views: Generator<JudgedView> = gs.composite((tc) => ({
  pages: tc.draw(gs.arrays(pages, { maxSize: 4 })),
  ...(tc.draw(gs.booleans()) ? { aria_in_claims: true as const } : {}),
}));

const records = gs.sampledFrom(["steps/step-20261103-025102-dcql", "steps/s/", "steps/with space"]);

const filesOf = (view: JudgedView): string[] =>
  view.pages.flatMap((page) => [page.screenshot, page.aria].flatMap((file) => (file === null ? [] : [file.file])));

describe("judgedViewForRun", () => {
  it("joins every file to the record and changes nothing else", () =>
    hegel.test((tc) => {
      const view = tc.draw(views);
      const record = tc.draw(records);
      const forRun = judgedViewForRun(view, record);
      const base = record.replace(/\/+$/, "");
      expect(filesOf(forRun)).toEqual(filesOf(view).map((file) => `${base}/${file}`));
      const withoutFiles = (each: JudgedView): unknown =>
        each.pages.map((page) => ({ ...page, screenshot: page.screenshot?.after_reading_ms ?? null, aria: page.aria?.after_reading_ms ?? null }));
      expect(withoutFiles(forRun)).toEqual(withoutFiles(view));
      expect(forRun.aria_in_claims).toBe(view.aria_in_claims);
    }));
});

describe("seenLinks", () => {
  it("links every file of the view once, in page order, each page's screenshot before its ARIA snapshot", () =>
    hegel.test((tc) => {
      const view = tc.draw(views);
      const links = seenLinks({ record: "steps/x", judged_view: view, observed: { http: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) } });
      expect(links.map((link) => link.href)).toEqual(filesOf(view));
      expect(links.map((link) => link.afterReadingMs)).toEqual(
        view.pages.flatMap((page) => [page.screenshot, page.aria].flatMap((file) => (file === null ? [] : [file.after_reading_ms]))),
      );
      // Pages told apart by context and place never share a label.
      if (new Set(view.pages.map((page) => `${page.as}\u0000${page.page}`)).size === view.pages.length) {
        expect(new Set(links.map((link) => link.label)).size).toBe(links.length);
      }
    }));

  it("links a Then that read no page to its step's http.jsonl when its step sent requests, and to nothing otherwise", () =>
    hegel.test((tc) => {
      const http = tc.draw(gs.oneOf(gs.just(null), gs.integers({ minValue: 0, maxValue: 3 })));
      const record = tc.draw(gs.oneOf(gs.just(null), records));
      const links = seenLinks({ record, observed: { http } });
      if (record !== null && http !== null && http > 0) {
        expect(links).toEqual([{ label: "responses", href: `${record.replace(/\/+$/, "")}/http.jsonl` }]);
      } else {
        expect(links).toEqual([]);
      }
    }));

  it("links a Then that read a page to its view or to nothing, never to its step's requests", () => {
    expect(seenLinks({ record: "steps/a", observed: { http: 2 }, pages: [{}] })).toEqual([]);
    expect(seenLinks({ record: "steps/a", observed: { http: 2 }, judged_view: { pages: [] } })).toEqual([]);
  });

  it("names the only page `page`, and each of several by its place and context", () => {
    const file = (name: string): JudgedViewFile => ({ file: name, after_reading_ms: 40 });
    const page = (as: string | null, at: number, aria: boolean): JudgedPageView => ({
      as,
      page: at,
      url: "http://localhost/",
      title: null,
      screenshot: file(`judged/${at}.png`),
      aria: aria ? file(`judged/${at}.aria.yml`) : null,
    });
    expect(seenLinks({ record: null, judged_view: { pages: [page(null, 1, true)] } }).map((link) => link.label)).toEqual(["page", "page ARIA"]);
    expect(seenLinks({ record: null, judged_view: { pages: [page(null, 1, false), page("aki", 1, true)] } }).map((link) => link.label)).toEqual([
      "page 1",
      "page 1 of aki",
      "page 1 of aki ARIA",
    ]);
  });
});

describe("markdownLink", () => {
  it("never breaks its line, and keeps a destination it can hold whole behind a label that reads back as given", () =>
    hegel.test((tc) => {
      const label = tc.draw(gs.text({ maxSize: 12, alphabet: "ab []\\" }));
      const href = tc.draw(gs.text({ maxSize: 16, alphabet: "steps/ab.png <>\n" }));
      const link = markdownLink(label, href);
      expect(link).not.toMatch(/[\r\n]/);
      if (/[<>\n\r]/.test(href)) {
        expect(link).not.toContain("](<");
        return;
      }
      const tail = `](<${href}>)`;
      expect(link.startsWith("[")).toBe(true);
      expect(link.endsWith(tail)).toBe(true);
      // Each bracket and backslash of the label is escaped, so none of them
      // ends the label early, and unescaping gives the label back.
      const text = link.slice(1, link.length - tail.length);
      expect(text.replace(/\\(.)/g, "$1")).toBe(label);
      expect(text.replace(/\\./g, "")).not.toMatch(/[[\]\\]/);
    }));

  it("writes a path relative to the summary as an angle-bracket destination", () => {
    expect(markdownLink("page", "steps/s 1/judged/page.png")).toBe("[page](<steps/s 1/judged/page.png>)");
    expect(markdownLink("a [b]", "x")).toBe("[a \\[b\\]](<x>)");
    expect(markdownLink("page", "a>b")).toBe("page `a>b`");
  });
});

describe("judgedViewAttachments", () => {
  it("attaches every file of the view once, as an image or as text, under names that tell pages apart", () =>
    hegel.test((tc) => {
      const view = tc.draw(views);
      const attached = judgedViewAttachments(view);
      expect(attached.map((file) => file.file)).toEqual(filesOf(view));
      for (const file of attached) expect(file.contentType).toBe(file.file.endsWith(".png") ? "image/png" : "text/plain");
      const distinctPages = new Set(view.pages.map((page) => `${page.as}\u0000${page.page}`)).size === view.pages.length;
      if (distinctPages) {
        const names = attached.map((file) => `${file.name}\u0000${file.contentType}`);
        expect(new Set(names).size).toBe(names.length);
      }
    }));

  it("attaches nothing for a step with no view", () => {
    expect(judgedViewAttachments(undefined)).toEqual([]);
  });
});
