import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import {
  judgeSnapshots,
  readActualSnapshot,
  readExpectedSnapshot,
  snapshotDifference,
  snapshotExcerpt,
  snapshotFits,
  snapshotMisfit,
  type ActualNode,
  type ActualRole,
} from "../src/step/aria-snapshot.js";

// Responsibility: the reading and fitting of ARIA snapshots behind the
// fits-aria-snapshot compare (src/step/aria-snapshot.ts). The properties
// print generated trees the way the browser's snapshot prints them,
// quoting included, and cut expected trees from them; the examples judge,
// word for word, the snapshot Playwright 1.61.1's `ariaSnapshot()`
// printed for a small room page.

/** A tree as the generator builds it, before it is printed. */
interface Tree {
  role: string;
  name: string;
  states: string[];
  url?: string;
  children: (Tree | string)[];
}

// Words a page shows, with the characters the format has to quote: a
// colon and a space, a hash after a space, a leading dash, quotes, a
// leading bracket, a number, YAML's own words. "~" and ".inf" are left
// out: the browser prints them plain and YAML reads them as null and a
// number, a hole in the format that the reader refuses loudly.
const WORDS = ["Room 7", "Score", "a: b", "x #1", "-5", "\"quoted\"", "it's", "[draft]", "42", "true", "Null", "é漢🙂", "Help", "one", "two"];
const ROLES = ["heading", "button", "list", "listitem", "form", "link", "checkbox", "paragraph", "navigation", "region"];
const STATES = ["checked", "checked=mixed", "disabled", "expanded", "level=1", "level=2", "pressed", "selected"];

function drawTree(tc: hegel.TestCase, depth: number): Tree {
  const tree: Tree = {
    role: tc.draw(gs.sampledFrom(ROLES)),
    name: tc.draw(gs.booleans()) ? tc.draw(gs.sampledFrom(WORDS)) : "",
    states: tc.draw(gs.booleans()) ? [tc.draw(gs.sampledFrom(STATES))] : [],
    children: [],
  };
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0) tree.url = tc.draw(gs.sampledFrom(["/help", "/rooms/7", "/a: b"]));
  const count = depth >= 3 ? 0 : tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
  for (let index = 0; index < count; index += 1) {
    tree.children.push(tc.draw(gs.integers({ minValue: 0, maxValue: 2 })) === 0 ? tc.draw(gs.sampledFrom(WORDS)) : drawTree(tc, depth + 1));
  }
  return tree;
}

// The browser's own quoting rule for a text in its snapshot, so the
// printed text is the one a page gives.
function needsQuotes(text: string): boolean {
  return (
    text.length === 0 ||
    /^\s|\s$/.test(text) ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text) ||
    /^-/.test(text) ||
    /[\n:](\s|$)/.test(text) ||
    /\s#/.test(text) ||
    /[\n\r]/.test(text) ||
    /^[&*\],?!>|@"'#%]/.test(text) ||
    /[{}`]/.test(text) ||
    /^\[/.test(text) ||
    !Number.isNaN(Number(text)) ||
    ["y", "n", "yes", "no", "true", "false", "on", "off", "null"].includes(text.toLowerCase())
  );
}

const keyText = (text: string): string => (needsQuotes(text) ? `'${text.replace(/'/g, "''")}'` : text);
const valueText = (text: string): string => (needsQuotes(text) ? JSON.stringify(text) : text);

function key(tree: Tree): string {
  return `${tree.role}${tree.name === "" ? "" : ` ${JSON.stringify(tree.name)}`}${tree.states.map((state) => ` [${state}]`).join("")}`;
}

/** The lines the browser prints for `trees`, `depth` levels in. */
function print(trees: readonly (Tree | string)[], depth = 0): string[] {
  const pad = "  ".repeat(depth);
  return trees.flatMap((tree) => {
    if (typeof tree === "string") return [`${pad}- text: ${valueText(tree)}`];
    const head = `${pad}- ${keyText(key(tree))}`;
    const only = tree.children.length === 1 && typeof tree.children[0] === "string" && tree.url === undefined ? tree.children[0] : undefined;
    if (only !== undefined) return [`${head}: ${valueText(only)}`];
    if (tree.children.length === 0 && tree.url === undefined) return [head];
    return [`${head}:`, ...(tree.url === undefined ? [] : [`${pad}  - /url: ${valueText(tree.url)}`]), ...print(tree.children, depth + 1)];
  });
}

/** An expected tree cut from `tree`: some of its children, in order, each
 * cut the same way, with its name and states kept or left unsaid. */
function cut(tc: hegel.TestCase, tree: Tree | string): Tree | string {
  if (typeof tree === "string") return tree;
  return {
    role: tree.role,
    name: tc.draw(gs.booleans()) ? tree.name : "",
    states: tc.draw(gs.booleans()) ? tree.states : [],
    ...(tree.url !== undefined && tc.draw(gs.booleans()) ? { url: tree.url } : {}),
    children: tree.children.filter(() => tc.draw(gs.booleans())).map((child) => cut(tc, child)),
  };
}

function* nodes(tree: Tree | string): Generator<Tree | string> {
  yield tree;
  if (typeof tree !== "string") for (const child of tree.children) yield* nodes(child);
}

/** `tree` with the node at pre-order place `place` (not the top) taken
 * out, with all it holds. */
function without(tree: Tree, place: number): Tree {
  let seen = 0;
  const walk = (node: Tree): Tree => ({
    ...node,
    children: node.children.flatMap((child) => {
      seen += 1;
      if (seen === place) return [];
      return [typeof child === "string" ? child : walk(child)];
    }),
  });
  return walk(tree);
}

const plain = (node: ActualNode): unknown =>
  node.kind === "text" ? node.text : { role: node.role, name: node.name, states: node.states, props: node.props, children: node.children.map(plain) };

const generatedPlain = (tree: Tree | string): unknown => {
  if (typeof tree === "string") return tree;
  const states: Record<string, unknown> = {};
  for (const state of tree.states) {
    const [name, value] = state.split("=");
    states[name!] = name === "level" ? Number(value) : (value ?? true);
  }
  return { role: tree.role, name: tree.name, states, props: tree.url === undefined ? {} : { url: tree.url }, children: tree.children.map(generatedPlain) };
};

function drawPage(tc: hegel.TestCase): { readonly trees: Tree[]; readonly text: string } {
  const trees = Array.from({ length: tc.draw(gs.integers({ minValue: 1, maxValue: 3 })) }, () => drawTree(tc, 0));
  return { trees, text: print(trees).join("\n") };
}

describe("readActualSnapshot", () => {
  it("reads back every tree the browser's snapshot prints", () =>
    hegel.test((tc) => {
      const { trees, text } = drawPage(tc);
      const read = readActualSnapshot(text);
      if ("problem" in read) throw new Error(`${read.problem}\n${text}`);
      expect(read.root.children.map(plain)).toEqual(trees.map(generatedPlain));
    }));
});

describe("snapshotFits", () => {
  it("holds for every expected tree cut from the actual one", () =>
    hegel.test((tc) => {
      const { trees, text } = drawPage(tc);
      const top: Tree = { role: "fragment", name: "", states: [], children: trees };
      const all = [...nodes(top)].filter((node): node is Tree => typeof node !== "string");
      const from = all[tc.draw(gs.integers({ minValue: 0, maxValue: all.length - 1 }))]!;
      const expected = cut(tc, from) as Tree;
      const docstring = print(from === top ? expected.children : [expected]).join("\n");
      const judged = judgeSnapshots(text, docstring);
      tc.assume(!("broken" in judged && judged.broken.includes("names no node")));
      expect(judged, `${docstring}\n--- fits ---\n${text}`).toEqual({ fits: true });
    }));

  it("still holds when a node is taken out of an expected tree that holds", () =>
    hegel.test((tc) => {
      const { trees, text } = drawPage(tc);
      const expected: Tree = { role: "fragment", name: "", states: [], children: trees.filter(() => tc.draw(gs.booleans())).map((tree) => cut(tc, tree)) };
      const size = [...nodes(expected)].length - 1;
      tc.assume(size >= 2);
      const place = tc.draw(gs.integers({ minValue: 1, maxValue: size }));
      const smaller = print(without(expected, place).children).join("\n");
      const judged = judgeSnapshots(text, smaller);
      tc.assume(!("broken" in judged));
      expect(judged, `${smaller}\n--- fits ---\n${text}`).toEqual({ fits: true });
    }));

  it("names where the two part exactly when the expected tree does not fit", () =>
    hegel.test((tc) => {
      const actualPage = drawPage(tc);
      const expectedPage = drawPage(tc);
      const actual = readActualSnapshot(actualPage.text);
      const expected = readExpectedSnapshot(print(expectedPage.trees.map((tree) => cut(tc, tree))).join("\n"));
      if ("problem" in actual || "problem" in expected) throw new Error("a printed tree did not read");
      tc.assume(expected.named > 0);
      expect(snapshotMisfit(actual.root, expected.root) === null).toBe(snapshotFits(actual.root, expected.root));
    }));

  it("excerpts the actual's own lines, at most 12, whenever the misfit names an actual line", () =>
    hegel.test((tc) => {
      const actualPage = drawPage(tc);
      const expectedText = print(drawPage(tc).trees.map((tree) => cut(tc, tree))).join("\n");
      const difference = snapshotDifference(actualPage.text, expectedText);
      const excerpt = snapshotExcerpt(actualPage.text, expectedText);
      expect(excerpt !== null).toBe(difference !== null && difference.includes("(actual line "));
      if (excerpt === null) return;
      expect(excerpt.last - excerpt.first).toBeLessThan(12);
      expect(excerpt.text).toBe(actualPage.text.split("\n").slice(excerpt.first - 1, excerpt.last).map((line) => (line.length > 120 ? `${line.slice(0, 120)}...` : line)).join("\n"));
    }));
});

// What `page.locator("body").ariaSnapshot()` printed for the fixture's
// room page.
const ROOM = [
  "- main:",
  '  - heading "Room 7" [level=1]',
  '  - form "Scores":',
  "    - text: Nickname",
  '    - textbox "Nickname": aki',
  '    - button "Score"',
  '    - button "Skip" [disabled]',
  "  - navigation:",
  '    - link "Help":',
  "      - /url: /help",
  "  - list:",
  "    - listitem: one",
  "    - listitem: two",
].join("\n");

describe("judgeSnapshots on a real page's snapshot", () => {
  it("holds on a partial tree and leaves the rest unasked", () => {
    expect(judgeSnapshots(ROOM, '- heading "Room 7"\n- form "Scores":\n  - button "Score"')).toEqual({ fits: true });
    expect(judgeSnapshots(ROOM, '- button "Skip" [disabled]')).toEqual({ fits: true });
    expect(judgeSnapshots(ROOM, '- link "Help":\n  - /url: /help')).toEqual({ fits: true });
    expect(judgeSnapshots(ROOM, '- textbox "Nickname": aki')).toEqual({ fits: true });
    expect(judgeSnapshots(ROOM, "- /url: /help\n- /url: /help")).toEqual({ fits: true });
    expect(judgeSnapshots(ROOM, '- button "Score" [disabled=false]')).toEqual({ fits: true });
    expect(judgeSnapshots(ROOM, "- list:\n  - /children: equal\n  - listitem: one\n  - listitem: two")).toEqual({ fits: true });
  });

  it("reads a child line as a child, not a node anywhere below", () => {
    expect(judgeSnapshots(ROOM, '- main:\n  - button "Score"')).toEqual({ fits: false });
  });

  // The nearest node is the one of the same role whose name is the fewest
  // edits away: "Skip" is 4 edits from "Submit", and "Score" is 5.
  it("names the first expected node that fits nothing, and the nearest actual node", () => {
    const differences = [
      '- heading "Room 7"\n- form "Scores":\n  - button "Submit"',
      '- main:\n  - button "Score"',
      '- heading "Lobby"',
      "- list:\n  - listitem: two\n  - listitem: one",
      "- list:\n  - /children: equal\n  - listitem: one",
      "- list:\n  - /children: equal\n  - listitem: one\n  - listitem: two\n  - listitem: three",
      '- link "Help":\n  - /url: /about',
      '- button "Skip" [disabled=false]',
      "- dialog",
      "- /url: /about\n- /url: /about",
      '- heading "Room 7"\n- spinbutton',
      '- form "Scores":\n  - textbox "Nickname"\n  - spinbutton',
    ].map((expected) => snapshotDifference(ROOM, expected));
    expect(differences).toEqual([
      'expected line 3 (button "Submit") fits no child of form "Scores" (actual line 3); nearest: button "Skip" [disabled] (actual line 7)',
      'expected line 2 (button "Score") fits no child of main (actual line 1); nearest: button "Score" (actual line 6), which sits deeper than a child',
      'expected line 1 (heading "Lobby") fits no node of the snapshot; nearest: heading "Room 7" [level=1] (actual line 2)',
      "expected line 3 (listitem: one) fits no child of list (actual line 11); nearest: listitem: one (actual line 12), which fits the line but an earlier line took it, or it sits out of the order the lines give",
      "expected line 1 (list) states /children: equal, and list (actual line 11) holds a child it does not name: listitem: two (actual line 13)",
      "expected line 5 (listitem: three) fits no child of list (actual line 11), which has 2 children and none at that place",
      'expected line 1 (link "Help") fits no node of the snapshot; nearest: link "Help" (actual line 9), whose /url is /help',
      'expected line 1 (button "Skip" [disabled=false]) fits no node of the snapshot; nearest: button "Skip" [disabled] (actual line 7), which prints [disabled]',
      "expected line 1 (dialog) fits no node of the snapshot, and no node there is a dialog",
      'expected line 1 (/url: /about) fits no node of the snapshot; nearest: link "Help" (actual line 9), whose /url is /help',
      'expected line 2 (spinbutton) fits no child of main (actual line 1), and no node there is a spinbutton; the child at that place is form "Scores" (actual line 3)',
      'expected line 3 (spinbutton) fits no child of form "Scores" (actual line 3), and no node there is a spinbutton; the child at that place is button "Score" (actual line 6)',
    ]);
  });

  it("excerpts the actual lines from where the expected line was looked for to the node the misfit names", () => {
    const excerpts = [
      '- heading "Room 7"\n- spinbutton',
      '- heading "Lobby"',
      "- list:\n  - /children: equal\n  - listitem: one\n  - listitem: two\n  - listitem: three",
      "- list:\n  - /children: equal\n  - listitem: one",
      '- heading "Room 7"\n- form "Scores":\n  - button "Submit"',
      "- dialog",
      '- heading "Room 7"',
    ].map((expected) => snapshotExcerpt(ROOM, expected));
    expect(excerpts).toEqual([
      { first: 1, last: 3, text: '- main:\n  - heading "Room 7" [level=1]\n  - form "Scores":' },
      { first: 2, last: 2, text: '  - heading "Room 7" [level=1]' },
      { first: 11, last: 13, text: "  - list:\n    - listitem: one\n    - listitem: two" },
      { first: 11, last: 13, text: "  - list:\n    - listitem: one\n    - listitem: two" },
      { first: 3, last: 7, text: ROOM.split("\n").slice(2, 7).join("\n") },
      null,
      null,
    ]);
  });

  it("refuses an expected tree that names no node, since every page holds it", () => {
    for (const empty of ["", "  \n", "# only a comment", '- text: ""', "- /children: equal"]) {
      expect(judgeSnapshots(ROOM, empty)).toEqual({ broken: "fits-aria-snapshot has an expected ARIA snapshot that names no node, which every page holds" });
    }
  });

  it("refuses, with its line, a docstring that names something nukadoko would not judge or that YAML reads otherwise", () => {
    const reasons = [
      "- heading /Room \\d+/",
      '- button "Score" [active]',
      '- /url: /help\n- link "Help"',
      "- listitem: 3.50",
      "- listitem: null",
      '- heading "Room 7" [level=one]',
      '- heading "Room 7" [focused]',
      "- [list]",
      '- heading "Room 7"\n  - button "Score"',
      '- form "Scores":\n\t- button "Score"',
      '- form "Scores":\n  button "Score"',
      "- list:",
      "- Room 7",
      "- paragraph: |\n    text",
    ].map((expected) => {
      const judged = judgeSnapshots(ROOM, expected);
      return "broken" in judged ? judged.broken.replace("the expected ARIA snapshot does not read: ", "") : judged;
    });
    expect(reasons).toEqual([
      "line 1 names heading with a pattern between slashes, which fits-aria-snapshot does not judge: state the name in double quotes, or claim the part that changes with another claim",
      "line 1 states [active], which the snapshot nukadoko takes does not print, so nothing could judge it",
      "line 1 states /url at the top of a list that names one node, so it describes no node: put it under the node it describes",
      'line 1 has the text 3.50, which YAML reads as 3.5: put the text in quotes, "3.50", to state it as written',
      "line 1 has the text null, which YAML reads as null: put the text in quotes",
      "line 1 gives [level] the value one, and a level is a whole number",
      "line 1 has the state [focused], which is none of checked, disabled, expanded, invalid, level, pressed, selected",
      "line 1 starts a text with [, which YAML reads as structure, not text: put the text in quotes",
      "line 2 is indented under an item that has no colon to open children",
      "line 2 is indented with a tab, and YAML indents with spaces only",
      'line 2 is no list item: an ARIA snapshot is a YAML list, and each item starts with "- "',
      'line 1 ends "list" with a colon and has nothing after it: write its text after the colon, its children on the lines below, or drop the colon',
      'line 1 has text after the role of Room that the key does not read: "7". A name goes in double quotes',
      "line 1 starts a YAML block text with |, which an ARIA snapshot does not use: write the text on the line, in double quotes with \\n for a new line",
    ]);
  });

  it("reads the YAML a person writes as the browser prints it: single quotes, a wider indent, comments, an escaped quote", () => {
    expect(judgeSnapshots(ROOM, "- 'heading \"Room 7\"'")).toEqual({ fits: true });
    expect(judgeSnapshots(ROOM, '- form "Scores":\n      - textbox "Nickname": aki # the field keeps its value')).toEqual({ fits: true });
    expect(judgeSnapshots('- paragraph: "Volume is set to \\"11\\": loud"', "- paragraph: 'Volume is set to \"11\": loud'")).toEqual({ fits: true });
    expect(judgeSnapshots("- paragraph: Last updated now", '- paragraph: "Last   updated   now"')).toEqual({ fits: true });
  });
});
