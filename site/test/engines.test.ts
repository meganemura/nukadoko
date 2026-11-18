import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import assert from "node:assert/strict";
import { test } from "node:test";
import { engineBlocks, wrapEngineBlocks } from "../scripts/document.ts";

// A document built from pieces whose engine standing is known in advance.
const pieces = {
  pair: ["```ruby", "class A < Nukadoko::Step; end", "```", "", "```ts", "export default defineStep({})", "```"],
  onlyRuby: ["<!-- engine: ruby -->", "```ruby", "x", "```"],
  onlyTs: ["<!-- engine: typescript -->", "```ts", "x", "```"],
  neither: ["<!-- engine: neither -->", "```ruby", "config.x = 1", "```"],
  loneTs: ["```ts", "x", "```"],
  loneRuby: ["```ruby", "x", "```"],
  text: ["Some text."],
  sh: ["```sh", "nuka run", "```"],
} as const;
type Piece = keyof typeof pieces;
const expected: Record<Piece, string[]> = {
  pair: ["pair"],
  onlyRuby: ["only:ruby"],
  onlyTs: ["only:typescript"],
  neither: ["neither"],
  loneTs: ["unpaired:typescript"],
  loneRuby: ["unpaired:ruby"],
  text: [],
  sh: [],
};
const names = Object.keys(pieces) as Piece[];

const shape = (lines: string[]) => engineBlocks(lines).map((b) => (b.engine ? `${b.kind}:${b.engine}` : b.kind));

test("each piece is read as what it is, whatever sits around it, when text separates the pieces", () =>
  hegel.test((tc) => {
    const drawn = tc.draw(gs.arrays(gs.sampledFrom(names), { maxSize: 12 }));
    const lines = drawn.flatMap((name) => ["Text between.", "", ...pieces[name], ""]);
    assert.deepEqual(shape(lines), drawn.flatMap((name) => expected[name]));
  }));

test("the number of blank lines between the two halves of a pair does not matter", () =>
  hegel.test((tc) => {
    const blanks = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
    const lines = ["```ruby", "a", "```", ...Array(blanks).fill(""), "```ts", "b", "```"];
    assert.deepEqual(shape(lines), ["pair"]);
  }));

test("a ts block before a ruby block is not a pair, and neither is a pair split by text", () => {
  assert.deepEqual(shape(["```ts", "a", "```", "```ruby", "b", "```"]), ["unpaired:typescript", "unpaired:ruby"]);
  assert.deepEqual(shape(["```ruby", "a", "```", "and then", "```ts", "b", "```"]), ["unpaired:ruby", "unpaired:typescript"]);
});

test("a fence inside a longer fence is content, not a block", () => {
  assert.deepEqual(shape(["````markdown", "```ts", "x", "```", "````"]), []);
});

test("wrapping adds only wrapper lines and blank lines, one .engine-pair per pair", () =>
  hegel.test((tc) => {
    const drawn = tc.draw(gs.arrays(gs.sampledFrom(names), { maxSize: 12 }));
    const lines = drawn.flatMap((name) => ["Text between.", "", ...pieces[name], ""]);
    const wrapped = wrapEngineBlocks(lines);
    const bare = (ls: string[]) => ls.filter((l) => l.trim() !== "" && !/^<\/?div\b/.test(l));
    assert.deepEqual(bare(wrapped), bare(lines));
    assert.equal(wrapped.filter((l) => l === '<div class="engine-pair">').length, drawn.filter((n) => n === "pair").length);
    assert.equal(wrapped.filter((l) => l.startsWith("<div")).length, wrapped.filter((l) => l === "</div>").length);
  }));
