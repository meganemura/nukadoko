import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import assert from "node:assert/strict";
import { test } from "node:test";
import { headingsOf, joinJapaneseLines, parseDocument, printDocument, rewriteLinks } from "../scripts/document.ts";

// Lines drawn from the shapes the documents mix: headings at each level, fences, quotes,
// list items, Japanese and English sentences, and links. Free text fills the rest.
const line = gs.sampledFrom([
  "# Title",
  "## A section",
  "## 節",
  "### Sub",
  "```ts",
  "```",
  "````markdown",
  "````",
  "~~~",
  "",
  "> 引用の一文です。",
  "> quoted text",
  "- 項目です。",
  "1. first",
  "   続きの行です。",
  "日本語の一文です。",
  "English sentence.",
  "**強調です。**",
  "see [the spec](spec.md#claims) and `[not](a.md)`",
  "| a | b |",
]);
const lines = gs.arrays(gs.oneOf(line, gs.text({ maxSize: 8 })), { maxSize: 40 });

test("cutting a document into sections and printing it again gives the same text", () =>
  hegel.test((tc) => {
    const text = tc.draw(lines).join("\n");
    assert.equal(printDocument(parseDocument(text)), text);
  }));

test("joining Japanese lines removes only line breaks and the indentation or quote marks after them", () =>
  hegel.test((tc) => {
    const input = tc.draw(lines);
    const squash = (ls: string[]) => ls.join("\n").replace(/[\s>]/g, "");
    assert.equal(squash(joinJapaneseLines(input)), squash(input));
  }));

test("joining Japanese lines leaves the headings as they are", () =>
  hegel.test((tc) => {
    const input = tc.draw(lines);
    assert.deepEqual(headingsOf(joinJapaneseLines(input)), headingsOf(input));
  }));

test("a rewrite that keeps each target keeps every line", () =>
  hegel.test((tc) => {
    const input = tc.draw(lines);
    assert.deepEqual(rewriteLinks(input, (target) => target), input);
  }));

test("a `## ` inside a fence is not a section", () => {
  const doc = parseDocument("# T\nintro\n## One\n```text\n## not a section\n```\n## Two\nbody");
  assert.equal(doc.title, "T");
  assert.deepEqual(doc.sections.map((s) => s.heading), ["One", "Two"]);
});

test("links are rewritten outside inline code and fences only", () => {
  const out = rewriteLinks(["[a](x.md) `[b](x.md)`", "```", "[c](x.md)", "```"], () => "Y");
  assert.deepEqual(out, ["[a](Y) `[b](x.md)`", "```", "[c](x.md)", "```"]);
});

test("Japanese sentences of one paragraph join, and a line ending in emphasis keeps its break", () => {
  assert.deepEqual(joinJapaneseLines(["一文目。", "二文目。", "", "- 項目。", "  続き。"]), ["一文目。二文目。", "", "- 項目。続き。"]);
  assert.deepEqual(joinJapaneseLines(["**強調。**", "本文。"]), ["**強調。**", "本文。"]);
  assert.deepEqual(joinJapaneseLines(["> 引用。", "> 続き。", "本文。"]), ["> 引用。続き。", "本文。"]);
});
