// Responsibility: what an ARIA snapshot says, and whether an expected one
// fits an actual one (docs/spec.md "Claims", `fits-aria-snapshot`). An
// ARIA snapshot is the YAML text `locator.ariaSnapshot()` prints for a
// page's accessibility tree: a list of nodes, each a role with an optional
// name and states, its text, and its children. This module reads two such
// texts, the one nukadoko took (the actual side) and the docstring a line
// states (the expected side), and judges whether every node the expected
// side names is in the actual tree, at the place it names it, leaving the
// rest of the tree unasked. It also names, for a broken claim, the first
// expected node that fits nothing and the actual node nearest to it.
//
// It is pure: it never touches a page. The claim judges the text the
// runner took, so the record shows the one value that was judged, and a
// reader can judge the record again from its two texts alone. That is why
// the matching reads the printed text and not the browser's own tree: a
// state the print leaves out (an unchecked box prints no `[checked]`) is
// absent here too, so `[checked=false]` holds on any node that prints no
// checked state, a button included.
//
// The reader takes the part of YAML an ARIA snapshot uses: a block list of
// items, each a key alone or one key with a text or a list of children,
// plain, single-quoted, or double-quoted scalars, and comments. Anything
// else (flow collections, block scalars, anchors, several keys in one
// item, tabs that indent) is refused with its line, as is a key the
// format does not have. A refusal names its line, and says how to write
// what the line meant.
//
// Three things the format allows are refused on the expected side, each
// because nukadoko would otherwise accept a line it does not judge: a
// pattern between slashes (`/Room \d+/`), which would need a regular
// expression run where it can be stopped (src/run/pattern-worker.ts), and
// the explanation of a broken claim is written later, from the record,
// where none can be; the state `[active]`, which the snapshot nukadoko
// takes does not print; and a `/` property at the top of a list that
// names one node, where the node is searched for alone and the property
// would describe nothing. A property at the top of any other list
// describes the node the list's items are children of, so `- /url: /help`
// alone names a node that links to /help.

// --- the YAML layer ---

/** One scalar of an item: its text after YAML unquoted it, and whether it
 * was written plain, which is when YAML may read it as a number, a
 * boolean, or null. */
interface Scalar {
  readonly text: string;
  readonly plain: boolean;
}

/** One item of the list: a key alone (`- button "Score"`), a key and its
 * text (`- listitem: one`), or a key and its children. `source` is the
 * item as written, after `- ` and before any comment, for a message. */
interface Item {
  readonly line: number;
  readonly source: string;
  readonly key: Scalar;
  readonly value?: Scalar;
  readonly children?: readonly Item[];
}

/** A line of the text that holds an item: its number from 1, the column
 * its content starts at, and the content. */
interface Line {
  readonly number: number;
  readonly indent: number;
  readonly content: string;
}

/** Why a text is no ARIA snapshot, with the line it found that on. */
class SnapshotProblem extends Error {}

function problemAt(line: number, message: string): SnapshotProblem {
  return new SnapshotProblem(`line ${line} ${message}`);
}

function contentLines(text: string): Line[] {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;
    const lead = /^[ \t]*/.exec(raw)![0];
    const content = raw.slice(lead.length);
    if (content === "" || content.startsWith("#")) return;
    if (lead.includes("\t")) throw problemAt(number, "is indented with a tab, and YAML indents with spaces only");
    if (lead.length === 0 && /^(---|\.\.\.)(\s|$)/.test(content)) throw problemAt(number, "is a YAML document marker, and an ARIA snapshot is one list");
    lines.push({ number, indent: lead.length, content });
  });
  return lines;
}

// YAML's indicators: a plain scalar may not start with one, since YAML
// reads it as structure (a flow collection, an anchor, a block scalar).
const PLAIN_START_REFUSED = new Set([",", "[", "]", "{", "}", "&", "*", "!", "|", ">", "%", "@", "`"]);

const DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: " ",
  P: " ",
};

const HEX_ESCAPE_LENGTH: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/** A quoted scalar at `start` of `text`: its value and the index after its
 * closing quote. */
function readQuoted(text: string, start: number, line: number): { readonly value: string; readonly end: number } {
  const quote = text[start]!;
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") {
        if (text[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        return { value, end: index + 1 };
      }
      value += char;
      index += 1;
      continue;
    }
    if (char === '"') return { value, end: index + 1 };
    if (char !== "\\") {
      value += char;
      index += 1;
      continue;
    }
    const escape = text[index + 1];
    if (escape === undefined) break;
    const hexLength = HEX_ESCAPE_LENGTH[escape];
    if (hexLength !== undefined) {
      const hex = text.slice(index + 2, index + 2 + hexLength);
      if (!new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(hex)) throw problemAt(line, `has \\${escape} in a double-quoted text without ${hexLength} hexadecimal digits after it`);
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 2 + hexLength;
      continue;
    }
    const replacement = DOUBLE_QUOTED_ESCAPES[escape];
    if (replacement === undefined) throw problemAt(line, `has the escape \\${escape}, which a double-quoted YAML text does not have`);
    value += replacement;
    index += 2;
  }
  throw problemAt(line, `opens a ${quote === '"' ? "double" : "single"}-quoted text that does not close on the line`);
}

/** Where a plain scalar that starts at `start` ends: before a `:` that a
 * space or the end follows, when `key` is true, or before a ` #` comment
 * either way. */
function plainEnd(text: string, start: number, key: boolean): number {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "#" && index > start && /\s/.test(text[index - 1]!)) return index;
    if (key && char === ":" && (index + 1 === text.length || /\s/.test(text[index + 1]!))) return index;
  }
  return text.length;
}

function readScalar(text: string, start: number, key: boolean, line: number): { readonly scalar: Scalar; readonly end: number } {
  const first = text[start]!;
  if (first === '"' || first === "'") {
    const quoted = readQuoted(text, start, line);
    return { scalar: { text: quoted.value, plain: false }, end: quoted.end };
  }
  if (PLAIN_START_REFUSED.has(first)) {
    throw problemAt(
      line,
      first === "|" || first === ">"
        ? `starts a YAML block text with ${first}, which an ARIA snapshot does not use: write the text on the line, in double quotes with \\n for a new line`
        : `starts a text with ${first}, which YAML reads as structure, not text: put the text in quotes`,
    );
  }
  if ((first === "-" || first === "?" || first === ":") && (start + 1 === text.length || /\s/.test(text[start + 1]!))) {
    throw problemAt(line, first === "-" ? "holds a list inside a list item, and each item is one node" : `starts with ${first} and a space, which YAML reads as structure, not text: put the text in quotes`);
  }
  const end = plainEnd(text, start, key);
  const value = text.slice(start, end).trimEnd();
  if (!key && /:\s/.test(value)) {
    throw problemAt(line, `holds a text with ": " in it, which YAML reads as a second key: put the text in quotes`);
  }
  return { scalar: { text: value, plain: true }, end: start + value.length };
}

function skipSpaces(text: string, index: number): number {
  while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  return index;
}

/** The rest of a line after a scalar may hold only spaces and a comment. */
function endsHere(text: string, index: number): boolean {
  const at = skipSpaces(text, index);
  return at === text.length || (text[at] === "#" && at > index);
}

/** One item's content after `- `: its key, whether a colon follows it,
 * and its text when one does. */
function readEntry(content: string, line: number): { readonly key: Scalar; readonly colon: boolean; readonly value?: Scalar; readonly source: string } {
  const read = readScalar(content, 0, true, line);
  let index = read.end;
  const after = skipSpaces(content, index);
  if (content[after] !== ":") {
    if (!endsHere(content, index)) throw problemAt(line, `has text after ${JSON.stringify(read.scalar.text)} that YAML does not read: put the whole key in quotes`);
    return { key: read.scalar, colon: false, source: content.slice(0, index).trim() };
  }
  index = after + 1;
  if (index < content.length && !/\s/.test(content[index]!)) throw problemAt(line, "has a colon with no space after it, which YAML reads as part of the key: put a space after the colon, or the key in quotes");
  const valueStart = skipSpaces(content, index);
  if (valueStart === content.length || content[valueStart] === "#") return { key: read.scalar, colon: true, source: content.slice(0, after).trim() };
  const value = readScalar(content, valueStart, false, line);
  if (!endsHere(content, value.end)) throw problemAt(line, `has text after its value that YAML does not read: put the value in quotes`);
  return { key: read.scalar, colon: true, value: value.scalar, source: content.slice(0, value.end).trim() };
}

function readList(lines: readonly Line[], start: number, indent: number): { readonly items: Item[]; readonly next: number } {
  const items: Item[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw problemAt(line.number, "is indented more than the item above it, which has no colon to open children");
    if (line.content !== "-" && !line.content.startsWith("- ")) {
      throw problemAt(line.number, 'is no list item: an ARIA snapshot is a YAML list, and each item starts with "- "');
    }
    const offset = skipSpaces(line.content, 1);
    if (offset === line.content.length || line.content[offset] === "#") throw problemAt(line.number, "is a list item with nothing in it");
    const entry = readEntry(line.content.slice(offset), line.number);
    index += 1;
    const keyColumn = line.indent + offset;
    const deeper = index < lines.length && lines[index]!.indent > line.indent ? lines[index]! : undefined;
    if (entry.colon && entry.value === undefined) {
      if (deeper === undefined) {
        throw problemAt(line.number, `ends ${JSON.stringify(entry.key.text)} with a colon and has nothing after it: write its text after the colon, its children on the lines below, or drop the colon`);
      }
      if (deeper.indent < keyColumn) throw problemAt(deeper.number, "is indented less than the key of the item it belongs to");
      const children = readList(lines, index, deeper.indent);
      items.push({ line: line.number, source: entry.source, key: entry.key, children: children.items });
      index = children.next;
      continue;
    }
    if (deeper !== undefined) {
      throw problemAt(
        deeper.number,
        deeper.indent === keyColumn && !deeper.content.startsWith("-")
          ? "is a second key of one list item, and each item names one node: start it with \"- \" as an item of its own"
          : "is indented under an item that has no colon to open children",
      );
    }
    items.push({ line: line.number, source: entry.source, key: entry.key, ...(entry.value === undefined ? {} : { value: entry.value }) });
  }
  return { items, next: index };
}

function readItems(text: string): readonly Item[] {
  const lines = contentLines(text);
  if (lines.length === 0) return [];
  const first = lines[0]!;
  const read = readList(lines, 0, first.indent);
  if (read.next < lines.length) throw problemAt(lines[read.next]!.number, "is indented less than the first item of the list");
  return read.items;
}

// What YAML's core schema reads a plain scalar as when it is not a string.
// A docstring writer who means the text "3.50" and writes it plain gets the
// number 3.5 from YAML, so such a value is refused, not read as other text.
const YAML_NULL = /^(?:~|null|Null|NULL)$/;
const YAML_BOOLEAN = /^(?:true|True|TRUE|false|False|FALSE)$/;
const YAML_NUMBER = /^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/;

/** The text a plain scalar on the expected side states, or why YAML reads
 * it as something else. A number or a boolean whose own text YAML gives
 * back unchanged (`42`, `true`) states that text. */
function statedText(scalar: Scalar, line: number, what: string): string {
  if (!scalar.plain) return scalar.text;
  const text = scalar.text;
  if (YAML_NULL.test(text)) throw problemAt(line, `has ${what} ${text}, which YAML reads as null: put the text in quotes`);
  const read = YAML_BOOLEAN.test(text) ? String(text.toLowerCase() === "true") : YAML_NUMBER.test(text) ? yamlNumberText(text) : text;
  if (read !== text) throw problemAt(line, `has ${what} ${text}, which YAML reads as ${read}: put the text in quotes, "${text}", to state it as written`);
  return text;
}

/** The text of the number YAML reads a plain scalar as. */
function yamlNumberText(text: string): string {
  if (/\.nan$/i.test(text)) return "NaN";
  if (/\.inf$/i.test(text)) return text.startsWith("-") ? "-Infinity" : "Infinity";
  return String(Number(text));
}

// --- the tree ---

/** The states a node may print in brackets after its name. */
const STATE_NAMES = ["checked", "disabled", "expanded", "invalid", "level", "pressed", "selected"] as const;

type StateName = (typeof STATE_NAMES)[number];

/** A node's states as the snapshot printed them: a state it did not
 * print is absent. */
export interface ActualStates {
  readonly checked?: true | "mixed";
  readonly disabled?: true;
  readonly expanded?: true;
  readonly invalid?: true | "grammar" | "spelling";
  readonly level?: number;
  readonly pressed?: true | "mixed";
  readonly selected?: true;
}

/** A node's states as a docstring states them: `false` states that the
 * node prints no such state. */
export interface ExpectedStates {
  readonly checked?: boolean | "mixed";
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly invalid?: boolean | "grammar" | "spelling";
  readonly level?: number;
  readonly pressed?: boolean | "mixed";
  readonly selected?: boolean;
}

/** One node of the snapshot nukadoko took. The top of the tree is a node
 * of role `fragment` that holds the list. `line` counts from 1 in the
 * snapshot's text. */
export type ActualNode =
  | {
      readonly kind: "role";
      readonly role: string;
      readonly name: string;
      readonly states: ActualStates;
      readonly props: Readonly<Record<string, string>>;
      readonly children: readonly ActualNode[];
      readonly line: number;
      readonly source: string;
    }
  | { readonly kind: "text"; readonly text: string; readonly line: number; readonly source: string };

export type ActualRole = Extract<ActualNode, { kind: "role" }>;

/** A text as a docstring states it, and with its white space folded the
 * way a page's text is: either one fits. */
export interface ExpectedText {
  readonly raw: string;
  readonly normalized: string;
}

/** How an expected node's children are read against the actual node's:
 * `contain` finds each in order and lets others sit between them, `equal`
 * wants exactly these children in this order, and `deep-equal` wants that
 * at every depth below. */
export type ChildrenMode = "contain" | "equal" | "deep-equal";

/** One node a docstring names. A `fragment` holds the list when it names
 * more than one node at the top, or states a children mode there; `line`
 * counts from 1 in the docstring. */
export type ExpectedNode =
  | {
      readonly kind: "role";
      readonly role: string;
      /** `""` names no name, so any name fits. */
      readonly name: string;
      readonly states: ExpectedStates;
      readonly props: Readonly<Record<string, ExpectedText>>;
      readonly children: readonly ExpectedNode[];
      readonly childrenMode?: ChildrenMode;
      readonly line: number;
      readonly source: string;
    }
  | { readonly kind: "text"; readonly text: ExpectedText; readonly line: number; readonly source: string };

export type ExpectedRole = Extract<ExpectedNode, { kind: "role" }>;

const FRAGMENT = "fragment";

/** White space folded the way the snapshot folds a page's text. */
function folded(text: string): string {
  return text.replace(/[​­]/g, "").replace(/\s+/g, " ").trim();
}

function expectedText(raw: string): ExpectedText {
  return { raw, normalized: folded(raw) };
}

/** A key's role, name, and states, read the way a docstring writes them:
 * a role, then a name in double quotes, then states in brackets. */
function expectedKey(key: string, line: number): { readonly role: string; readonly name: string; readonly states: ExpectedStates } {
  let index = skipSpaces(key, 0);
  const roleStart = index;
  while (index < key.length && /[a-zA-Z]/.test(key[index]!)) index += 1;
  const role = key.slice(roleStart, index);
  if (role === "") throw problemAt(line, `names no role in ${JSON.stringify(key)}: an item starts with a role, such as heading or button`);
  index = skipSpaces(key, index);
  let name = "";
  if (key[index] === '"') {
    let value = "";
    index += 1;
    let closed = false;
    while (index < key.length) {
      const char = key[index]!;
      index += 1;
      if (char === "\\" && index < key.length) {
        value += key[index]!;
        index += 1;
      } else if (char === '"') {
        closed = true;
        break;
      } else value += char;
    }
    if (!closed) throw problemAt(line, `opens the name of ${role} with a quote that does not close. A ": " inside a name ends a key in YAML, so put such a key in single quotes`);
    name = folded(value);
  } else if (key[index] === "/") {
    throw problemAt(line, `names ${role} with a pattern between slashes, which fits-aria-snapshot does not judge: state the name in double quotes, or claim the part that changes with another claim`);
  }
  const states: Record<string, unknown> = {};
  for (;;) {
    index = skipSpaces(key, index);
    if (key[index] !== "[") break;
    const close = key.indexOf("]", index);
    if (close === -1) throw problemAt(line, `opens a state of ${role} with [ and does not close it`);
    const body = key.slice(index + 1, close).trim();
    const match = /^([a-zA-Z]+)\s*(?:=\s*(\S*))?$/.exec(body);
    if (match === null) throw problemAt(line, `has the state [${body}], which is no state a snapshot prints`);
    applyState(states, match[1]!, match[2] === undefined || match[2] === "" ? "true" : match[2], line);
    index = close + 1;
  }
  if (index < key.length) throw problemAt(line, `has text after the role${name === "" ? "" : " and the name"} of ${role} that the key does not read: ${JSON.stringify(key.slice(index))}. A name goes in double quotes`);
  return { role, name, states: states as ExpectedStates };
}

const TOGGLE = new Set(["true", "false"]);
const TOGGLE_OR_MIXED = new Set(["true", "false", "mixed"]);

function applyState(states: Record<string, unknown>, state: string, value: string, line: number): void {
  const flag = (allowed: ReadonlySet<string>, what: string): boolean | string => {
    if (!allowed.has(value)) throw problemAt(line, `gives [${state}] the value ${value}, and ${state} is ${what}`);
    return value === "true" ? true : value === "false" ? false : value;
  };
  switch (state) {
    case "checked":
    case "pressed":
      states[state] = flag(TOGGLE_OR_MIXED, "true, false, or mixed");
      return;
    case "disabled":
    case "expanded":
    case "selected":
      states[state] = flag(TOGGLE, "true or false");
      return;
    case "invalid":
      states[state] = flag(new Set(["true", "false", "grammar", "spelling"]), "true, false, grammar, or spelling");
      return;
    case "level":
      if (!/^[0-9]+$/.test(value)) throw problemAt(line, `gives [level] the value ${value}, and a level is a whole number`);
      states[state] = Number(value);
      return;
    case "active":
      throw problemAt(line, "states [active], which the snapshot nukadoko takes does not print, so nothing could judge it");
    default:
      throw problemAt(line, `has the state [${state}], which is none of ${STATE_NAMES.join(", ")}`);
  }
}

function expectedChildren(
  items: readonly Item[],
  container: { children: ExpectedNode[]; props: Record<string, ExpectedText>; childrenMode?: ChildrenMode; firstProp?: Item },
): void {
  for (const item of items) {
    if (item.key.plain && (YAML_NULL.test(item.key.text) || YAML_BOOLEAN.test(item.key.text) || YAML_NUMBER.test(item.key.text))) {
      throw problemAt(item.line, `has the key ${item.key.text}, which YAML reads as no text: an item starts with a role, such as heading or button`);
    }
    const key = item.key.text;
    if (item.value === undefined && item.children === undefined) {
      container.children.push(roleNode(item, expectedKey(key, item.line), []));
      continue;
    }
    if (key === "text" || key === "/children" || key.startsWith("/")) {
      if (item.value === undefined) throw problemAt(item.line, `gives ${key} children, and it takes a text after the colon`);
      const value = statedText(item.value, item.line, `the ${key === "text" ? "text" : "value"}`);
      if (key === "text") container.children.push({ kind: "text", text: expectedText(value), line: item.line, source: item.source });
      else if (key === "/children") {
        if (value !== "contain" && value !== "equal" && value !== "deep-equal") throw problemAt(item.line, `gives /children the value ${value}, and it is contain, equal, or deep-equal`);
        container.childrenMode = value;
      } else {
        if (key.length === 1) throw problemAt(item.line, "names a property with no name after the /");
        container.props[key.slice(1)] = expectedText(value);
        container.firstProp ??= item;
      }
      continue;
    }
    const parsed = expectedKey(key, item.line);
    if (item.value !== undefined) {
      const text = statedText(item.value, item.line, "the text");
      container.children.push(roleNode(item, parsed, [{ kind: "text", text: expectedText(text), line: item.line, source: item.source }]));
      continue;
    }
    const node = { kind: "role" as const, ...parsed, props: {} as Record<string, ExpectedText>, children: [] as ExpectedNode[], line: item.line, source: item.source } as {
      kind: "role";
      role: string;
      name: string;
      states: ExpectedStates;
      props: Record<string, ExpectedText>;
      children: ExpectedNode[];
      childrenMode?: ChildrenMode;
      line: number;
      source: string;
    };
    expectedChildren(item.children!, node);
    container.children.push(node);
  }
}

function roleNode(item: Item, key: { readonly role: string; readonly name: string; readonly states: ExpectedStates }, children: ExpectedNode[]): ExpectedNode {
  return { kind: "role", ...key, props: {}, children, line: item.line, source: item.source };
}

/** What a docstring reads as: the node the matching searches for (a
 * fragment when it names several at the top, or states a children mode
 * there), and how many nodes it names, or why it reads as no snapshot. */
export type ExpectedSnapshot = { readonly root: ExpectedNode; readonly named: number } | { readonly problem: string };

/** The tree a docstring states. Pure. */
export function readExpectedSnapshot(text: string): ExpectedSnapshot {
  try {
    const top: { children: ExpectedNode[]; props: Record<string, ExpectedText>; childrenMode?: ChildrenMode; firstProp?: Item } = { children: [], props: {} };
    expectedChildren(readItems(text), top);
    // One node at the top is searched for alone, anywhere in the tree;
    // several are searched for together, as children of one node, which
    // a property at the top describes.
    const single = top.children.length === 1 && (top.childrenMode === undefined || top.childrenMode === "contain");
    if (single && top.firstProp !== undefined) {
      throw problemAt(
        top.firstProp.line,
        `states ${top.firstProp.key.text} at the top of a list that names one node, so it describes no node: put it under the node it describes`,
      );
    }
    const fragment: ExpectedNode = {
      kind: "role",
      role: FRAGMENT,
      name: "",
      states: {},
      props: top.props,
      children: top.children,
      ...(top.childrenMode === undefined ? {} : { childrenMode: top.childrenMode }),
      line: top.firstProp?.line ?? 0,
      source: top.firstProp?.source ?? "the list",
    };
    return { root: single ? top.children[0]! : fragment, named: countNamed(top.children) + statedProps(top.props) };
  } catch (error) {
    if (error instanceof SnapshotProblem) return { problem: error.message };
    throw error;
  }
}

/** The properties a node states that a page could lack: each one whose
 * text is not empty, since an empty text fits any text. */
function statedProps(props: Readonly<Record<string, ExpectedText>>): number {
  return Object.values(props).filter((text) => text.normalized !== "").length;
}

/** The nodes a list names that a page could lack: every role, and every
 * text that is not empty, since an empty text fits any text. */
function countNamed(nodes: readonly ExpectedNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === "text") count += node.text.normalized === "" ? 0 : 1;
    else count += 1 + countNamed(node.children);
  }
  return count;
}

const PRINTED_STATE = /^(checked|disabled|expanded|invalid|level|pressed|selected)(?:=(mixed|grammar|spelling|[0-9]+))?$/;

/** A key as the snapshot prints it: a role, then a name as a JSON string,
 * or as it is when it starts and ends with a slash, then its states. */
function actualKey(key: string, line: number): { readonly role: string; readonly name: string; readonly states: ActualStates } {
  const roleMatch = /^[a-zA-Z]+/.exec(key);
  if (roleMatch === null) throw problemAt(line, `prints no role in ${JSON.stringify(key)}`);
  const role = roleMatch[0];
  let rest = key.slice(role.length);
  const states: Record<string, unknown> = {};
  // The printer writes the states last, from a fixed set, so they are read
  // from the end: a name may hold brackets of its own.
  for (;;) {
    const state = / \[([^\]\s]+)\]$/.exec(rest);
    if (state === null) break;
    const parsed = PRINTED_STATE.exec(state[1]!);
    if (parsed === null) break;
    const [, stateName, value] = parsed;
    states[stateName!] = stateName === "level" ? Number(value) : value === undefined ? true : value;
    rest = rest.slice(0, state.index);
  }
  if (rest === "") return { role, name: "", states: states as ActualStates };
  if (!rest.startsWith(" ")) throw problemAt(line, `prints ${JSON.stringify(key)}, which is no role, name, and states`);
  const written = rest.slice(1);
  if (written.startsWith('"')) {
    try {
      const name: unknown = JSON.parse(written);
      if (typeof name === "string") return { role, name, states: states as ActualStates };
    } catch {
      // Falls through to the problem below.
    }
    throw problemAt(line, `prints the name ${written}, which is no JSON string`);
  }
  if (written.length > 1 && written.startsWith("/") && written.endsWith("/")) return { role, name: written, states: states as ActualStates };
  throw problemAt(line, `prints ${JSON.stringify(key)}, which is no role, name, and states`);
}

function actualChildren(items: readonly Item[], container: { children: ActualNode[]; props: Record<string, string> }): void {
  for (const item of items) {
    const key = item.key.text;
    if (item.value === undefined && item.children === undefined) {
      container.children.push({ kind: "role", ...actualKey(key, item.line), props: {}, children: [], line: item.line, source: item.source });
      continue;
    }
    if (key === "text" || key.startsWith("/")) {
      if (item.value === undefined) throw problemAt(item.line, `prints ${key} with children`);
      if (key === "text") container.children.push({ kind: "text", text: item.value.text, line: item.line, source: item.source });
      else container.props[key.slice(1)] = item.value.text;
      continue;
    }
    const node = { kind: "role" as const, ...actualKey(key, item.line), props: {} as Record<string, string>, children: [] as ActualNode[], line: item.line, source: item.source };
    if (item.value !== undefined) node.children.push({ kind: "text", text: item.value.text, line: item.line, source: item.source });
    else actualChildren(item.children!, node);
    container.children.push(node);
  }
}

/** What the snapshot nukadoko took reads as: the tree, under a node of
 * role `fragment` that holds its list, or why it does not read. */
export type ActualSnapshot = { readonly root: ActualRole } | { readonly problem: string };

/** The tree a printed snapshot shows. A plain scalar is the text it
 * spells: the printer quotes every text YAML would read otherwise. Pure. */
export function readActualSnapshot(text: string): ActualSnapshot {
  try {
    const root = { kind: "role" as const, role: FRAGMENT, name: "", states: {}, props: {} as Record<string, string>, children: [] as ActualNode[], line: 0, source: "the snapshot" };
    actualChildren(readItems(text), root);
    return { root };
  } catch (error) {
    if (error instanceof SnapshotProblem) return { problem: error.message };
    throw error;
  }
}

// --- fitting ---

function textFits(actual: string | undefined, expected: ExpectedText): boolean {
  if (expected.normalized === "") return true;
  if (actual === undefined || actual === "") return false;
  return actual === expected.normalized || actual === expected.raw;
}

function stateFits(state: StateName, actual: ActualStates, expected: ExpectedStates): boolean {
  const stated = expected[state];
  if (stated === undefined) return true;
  const printed = actual[state];
  if (stated === false) return printed === undefined;
  return printed === stated;
}

/** Whether `actual` is the node `expected` names, by its own line alone:
 * its role, name, states, and properties, and for a text, its text. */
function nodeFits(actual: ActualNode, expected: ExpectedNode): boolean {
  if (expected.kind === "text") return actual.kind === "text" && textFits(actual.text, expected.text);
  if (actual.kind !== "role") return false;
  if (expected.role !== FRAGMENT && expected.role !== actual.role) return false;
  if (!STATE_NAMES.every((state) => stateFits(state, actual.states, expected.states))) return false;
  if (expected.name !== "" && actual.name !== expected.name) return false;
  return Object.entries(expected.props).every(([prop, text]) => textFits(actual.props[prop], text));
}

type ChildrenReading = { readonly kind: "contain" } | { readonly kind: "equal"; readonly deep: boolean };

/** How `expected`'s children are read: its own mode wins, and under a
 * `deep-equal` above it, every list is read whole. */
function childrenReading(expected: ExpectedRole, deep: boolean): ChildrenReading {
  if (expected.childrenMode === "contain") return { kind: "contain" };
  if (expected.childrenMode === "equal") return { kind: "equal", deep: false };
  if (expected.childrenMode === "deep-equal" || deep) return { kind: "equal", deep: true };
  return { kind: "contain" };
}

function treeFits(actual: ActualNode, expected: ExpectedNode, deep: boolean): boolean {
  if (!nodeFits(actual, expected)) return false;
  if (expected.kind === "text") return true;
  const children = (actual as ActualRole).children;
  const reading = childrenReading(expected, deep);
  if (reading.kind === "equal") {
    return children.length === expected.children.length && expected.children.every((child, index) => treeFits(children[index]!, child, reading.deep));
  }
  // In order, each expected child at the first actual child after the one
  // before it that fits: taking the first never leaves a later expected
  // child fewer places to fit.
  let next = 0;
  for (const child of expected.children) {
    while (next < children.length && !treeFits(children[next]!, child, false)) next += 1;
    if (next === children.length) return false;
    next += 1;
  }
  return true;
}

function* everyNode(node: ActualNode): Generator<ActualNode> {
  yield node;
  if (node.kind === "role") for (const child of node.children) yield* everyNode(child);
}

/** Whether the tree an expected snapshot names is in the actual tree: its
 * top node fits some actual node at any depth, each of its children fits a
 * child of that node, in order, with other children between them unasked,
 * and so on down, unless a `/children` mode asks for every child. Pure. */
export function snapshotFits(actual: ActualRole, expected: ExpectedNode): boolean {
  for (const node of everyNode(actual)) if (treeFits(node, expected, false)) return true;
  return false;
}

// --- explaining a misfit ---


/** Where a broken claim's expected snapshot first parts from the actual
 * one, in the docstring's order:
 * - `unmatched`: an expected node no actual node fits where the nodes
 *   above it fit, with the actual node it was looked for under (`null`
 *   for anywhere in the snapshot), the actual node nearest to it (`null`
 *   when none there is of its role, or a text for a text), the actual
 *   child its previous expected sibling fit (`null` for a first child),
 *   and the actual children it could have fit in their order: those
 *   between the children its previous and its next sibling fit;
 * - `missing`: an expected child of a node whose children mode asks for
 *   every child, past the last child the actual node has;
 * - `extra`: an actual child that such a node does not name. */
export type SnapshotMisfit =
  | {
      readonly kind: "unmatched";
      readonly expected: ExpectedNode;
      readonly inside: ActualRole | null;
      readonly nearest: { readonly node: ActualNode; readonly relation: Nearness } | null;
      readonly after: ActualNode | null;
      readonly place: readonly ActualNode[];
    }
  | { readonly kind: "missing"; readonly expected: ExpectedNode; readonly inside: ActualRole }
  | { readonly kind: "extra"; readonly expected: ExpectedRole; readonly actual: ActualRole; readonly extra: ActualNode };

/** How the nearest actual node stands to the expected one: a child of the
 * node it was looked for under, the child at its place under a children
 * mode, a node deeper than a child, or one that fits its line, which the
 * alignment gave to an earlier expected line or which sits out of order. */
export type Nearness = "child" | "at-place" | "deeper" | "fits";

/** The text an expected line states after its key (`- listitem: one`),
 * which the line reads as part of the node it names. */
function inlineText(expected: ExpectedNode): ExpectedText | undefined {
  if (expected.kind !== "role" || expected.children.length !== 1) return undefined;
  const only = expected.children[0]!;
  return only.kind === "text" && only.line === expected.line ? only.text : undefined;
}

/** Whether `actual` is the node an expected line names, its inline text
 * included, so an explanation pairs `listitem: two` with the item that
 * reads "two" before one that is only a list item. */
function lineFits(actual: ActualNode, expected: ExpectedNode): boolean {
  if (!nodeFits(actual, expected)) return false;
  const text = inlineText(expected);
  return text === undefined || (actual as ActualRole).children.some((child) => child.kind === "text" && textFits(child.text, text));
}

/** How many nodes of an expected tree fit under an actual node, for each
 * pairing, kept so the alignment counts each pair once. */
class Scores {
  private readonly memo = { contain: new Map<ExpectedNode, Map<ActualNode, number>>(), deep: new Map<ExpectedNode, Map<ActualNode, number>>() };

  /** The nodes of `expected`'s tree that fit under `actual`, `expected`
   * itself included (a fragment counts for none): 0 when `actual` is not
   * the node `expected` names. */
  of(expected: ExpectedNode, actual: ActualNode, deep: boolean): number {
    const table = deep ? this.memo.deep : this.memo.contain;
    let byActual = table.get(expected);
    if (byActual === undefined) table.set(expected, (byActual = new Map()));
    const cached = byActual.get(actual);
    if (cached !== undefined) return cached;
    const score = this.compute(expected, actual, deep);
    byActual.set(actual, score);
    return score;
  }

  private compute(expected: ExpectedNode, actual: ActualNode, deep: boolean): number {
    if (!lineFits(actual, expected)) return 0;
    if (expected.kind === "text") return 1;
    const own = expected.role === FRAGMENT ? statedProps(expected.props) : 1;
    const children = (actual as ActualRole).children;
    const reading = childrenReading(expected, deep);
    if (reading.kind === "contain") return own + this.aligned(expected.children, children).score;
    let sum = 0;
    expected.children.forEach((child, index) => {
      const at = children[index];
      if (at !== undefined) sum += this.of(child, at, reading.deep);
    });
    return own + sum;
  }

  /** The in-order pairing of expected children with actual children that
   * fits the most expected nodes; of equals, the one that pairs each
   * expected child with the earliest actual child it can. */
  aligned(expected: readonly ExpectedNode[], actual: readonly ActualNode[]): { readonly score: number; readonly pairs: ReadonlyMap<number, number> } {
    const best: number[][] = Array.from({ length: expected.length + 1 }, () => new Array<number>(actual.length + 1).fill(0));
    for (let i = expected.length - 1; i >= 0; i -= 1) {
      for (let j = actual.length - 1; j >= 0; j -= 1) {
        const paired = this.of(expected[i]!, actual[j]!, false);
        best[i]![j] = Math.max(best[i]![j + 1]!, best[i + 1]![j]!, paired === 0 ? 0 : paired + best[i + 1]![j + 1]!);
      }
    }
    const pairs = new Map<number, number>();
    let i = 0;
    let j = 0;
    while (i < expected.length && j < actual.length) {
      const paired = this.of(expected[i]!, actual[j]!, false);
      if (paired > 0 && paired + best[i + 1]![j + 1]! === best[i]![j]) {
        pairs.set(i, j);
        i += 1;
        j += 1;
      } else if (best[i]![j + 1] === best[i]![j]) j += 1;
      else i += 1;
    }
    return { score: best[0]![0]!, pairs };
  }
}

/** The edit distance between two texts, each cut to its first 200
 * characters, so a long name costs no more than a short one. */
function editDistance(a: string, b: string): number {
  const left = a.slice(0, 200);
  const right = b.slice(0, 200);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** Of `candidates`, the one most like `expected`: a node of its role, or
 * a text for a text, whose name or text is nearest to the one it states,
 * the earliest of equals; `null` when none is of its role. */
function mostAlike(expected: ExpectedNode, candidates: Iterable<ActualNode>): ActualNode | null {
  let best: ActualNode | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    let d: number;
    if (expected.kind === "text") {
      if (candidate.kind !== "text") continue;
      d = editDistance(candidate.text, expected.text.normalized);
    } else if (expected.role === FRAGMENT) {
      if (candidate.kind !== "role") continue;
      const stated = Object.entries(expected.props);
      if (!stated.some(([prop]) => candidate.props[prop] !== undefined)) continue;
      d = stated.reduce((sum, [prop, text]) => sum + editDistance(candidate.props[prop] ?? "", text.normalized), 0);
    } else {
      if (candidate.kind !== "role" || candidate.role !== expected.role) continue;
      const text = inlineText(expected);
      d = editDistance(candidate.name, expected.name) + (text === undefined ? 0 : Math.min(...candidate.children.map((child) => (child.kind === "text" ? editDistance(child.text, text.normalized) : text.normalized.length))));
    }
    if (d < distance) {
      best = candidate;
      distance = d;
    }
  }
  return best;
}

function* below(node: ActualRole): Generator<ActualNode> {
  for (const child of node.children) yield* everyNode(child);
}

/** Where an expected child could go among the actual children under a
 * contain reading: after the child its previous sibling fit. */
interface Place {
  readonly after: ActualNode | null;
  readonly place: readonly ActualNode[];
}

const NOWHERE: Place = { after: null, place: [] };

function unmatched(expected: ExpectedNode, inside: ActualRole | null, root: ActualRole, where: Place = NOWHERE): SnapshotMisfit {
  const near = (node: ActualNode | null, relation: Nearness): SnapshotMisfit => ({
    kind: "unmatched",
    expected,
    inside,
    nearest: node === null ? null : { node, relation: relation === "child" && lineFits(node, expected) ? "fits" : relation },
    ...where,
  });
  if (inside === null) return near(mostAlike(expected, below(root)), "child");
  const child = mostAlike(expected, inside.children);
  return child !== null ? near(child, "child") : near(mostAlike(expected, below(inside)), "deeper");
}

function explainAt(scores: Scores, expected: ExpectedNode, actual: ActualNode, deep: boolean, root: ActualRole): SnapshotMisfit | null {
  if (expected.kind === "text") return null;
  const node = actual as ActualRole;
  const reading = childrenReading(expected, deep);
  if (reading.kind === "equal") {
    for (const [index, child] of expected.children.entries()) {
      const at = node.children[index];
      if (at === undefined) return { kind: "missing", expected: child, inside: node };
      if (scores.of(child, at, reading.deep) === 0) {
        return { kind: "unmatched", expected: child, inside: node, nearest: { node: at, relation: "at-place" }, after: node.children[index - 1] ?? null, place: [at] };
      }
      const deeper = explainAt(scores, child, at, reading.deep, root);
      if (deeper !== null) return deeper;
    }
    const extra = node.children[expected.children.length];
    return extra === undefined ? null : { kind: "extra", expected, actual: node, extra };
  }
  // A fragment's best place may be the top of the snapshot, whose list is
  // no node a reader can look at.
  const inside = node === root ? null : node;
  const { pairs } = scores.aligned(expected.children, node.children);
  for (const [index, child] of expected.children.entries()) {
    const at = pairs.get(index);
    if (at === undefined) {
      // Every earlier child is paired, so the place starts after the
      // previous one's pair and ends before the next sibling's, if any.
      const previous = pairs.get(index - 1);
      const next = expected.children.findIndex((_, later) => later > index && pairs.has(later));
      const place = node.children.slice((previous ?? -1) + 1, next === -1 ? undefined : pairs.get(next));
      return unmatched(child, inside, root, { after: previous === undefined ? null : node.children[previous]!, place });
    }
    const deeper = explainAt(scores, child, node.children[at]!, false, root);
    if (deeper !== null) return deeper;
  }
  return null;
}

/** Where `expected` first parts from `actual`, or `null` when it fits.
 * The walk starts at the actual node the expected tree fits best, the
 * earliest of equals, and follows the docstring's order from there, so
 * the node it names is the first one a reader of the docstring reaches
 * that the page does not show there. Pure. */
export function snapshotMisfit(actual: ActualRole, expected: ExpectedNode): SnapshotMisfit | null {
  if (snapshotFits(actual, expected)) return null;
  const scores = new Scores();
  let best: ActualNode | null = null;
  let bestScore = 0;
  for (const node of everyNode(actual)) {
    const score = scores.of(expected, node, false);
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  // A fragment fits every node of a role, so its best place counts the
  // children it fits; with none, the first of them fits nothing anywhere.
  const top = expected.kind === "role" && expected.role === FRAGMENT ? expected.children[0] : expected;
  if (best === null) return unmatched(top ?? expected, null, actual);
  // The alignment counts what `snapshotFits` judged, so it finds where the
  // two part; the fallback only keeps the result whole.
  return explainAt(scores, expected, best, false, actual) ?? unmatched(top ?? expected, null, actual);
}

const SOURCE_LIMIT = 120;

function sourceText(source: string): string {
  return source.length > SOURCE_LIMIT ? `${source.slice(0, SOURCE_LIMIT)}...` : source;
}

function actualNamed(node: ActualNode): string {
  return `${sourceText(node.source)} (actual line ${node.line})`;
}

function expectedNamed(node: ExpectedNode): string {
  return `expected line ${node.line} (${sourceText(node.source)})`;
}

/** What keeps an actual node of the expected line's role and name from
 * fitting it: the first state or property it prints otherwise, or `null`
 * when the two lines already show it. */
function lineDifference(actual: ActualNode, expected: ExpectedNode): string | null {
  if (actual.kind !== "role" || expected.kind !== "role") return null;
  if (expected.role !== FRAGMENT && (actual.role !== expected.role || (expected.name !== "" && actual.name !== expected.name))) return null;
  for (const state of STATE_NAMES) {
    if (stateFits(state, actual.states, expected.states)) continue;
    const printed = actual.states[state];
    if (printed === undefined) return `which prints no ${state} state`;
    return `which prints [${printed === true ? state : `${state}=${String(printed)}`}]`;
  }
  for (const [prop, text] of Object.entries(expected.props)) {
    if (textFits(actual.props[prop], text)) continue;
    const printed = actual.props[prop];
    return printed === undefined ? `which has no /${prop}` : `whose /${prop} is ${sourceText(printed)}`;
  }
  return null;
}

function roleWords(expected: ExpectedNode): string {
  if (expected.kind === "text") return "a text";
  if (expected.role === FRAGMENT) return `a node with ${Object.keys(expected.props).map((prop) => `/${prop}`).join(" and ")}`;
  return /^[aeiou]/i.test(expected.role) ? `an ${expected.role}` : `a ${expected.role}`;
}

/** A misfit as one line: the expected node by its docstring line, where
 * it was looked for, and the nearest actual node by its snapshot line.
 * Pure. */
export function misfitText(misfit: SnapshotMisfit): string {
  switch (misfit.kind) {
    case "extra": {
      const stated = misfit.expected.role === FRAGMENT ? "the expected list" : expectedNamed(misfit.expected);
      return `${stated} states /children: ${misfit.expected.childrenMode ?? "deep-equal"}, and ${actualNamed(misfit.actual)} holds a child it does not name: ${actualNamed(misfit.extra)}`;
    }
    case "missing":
      return `${expectedNamed(misfit.expected)} fits no child of ${actualNamed(misfit.inside)}, which has ${misfit.inside.children.length === 1 ? "1 child" : `${misfit.inside.children.length} children`} and none at that place`;
    case "unmatched": {
      const where = misfit.inside === null ? "no node of the snapshot" : `no child of ${actualNamed(misfit.inside)}`;
      const head = `${expectedNamed(misfit.expected)} fits ${where}`;
      const nearest = misfit.nearest;
      if (nearest === null) {
        const none = `${head}, and no node there is ${roleWords(misfit.expected)}`;
        const [first] = misfit.place;
        if (first === undefined) return none;
        if (misfit.place.length === 1) return `${none}; the child at that place is ${actualNamed(first)}`;
        return `${none}; the ${misfit.place.length} children at that place are actual lines ${first.line} to ${lastLine(misfit.place.at(-1)!)}`;
      }
      switch (nearest.relation) {
        case "child": {
          const detail = lineDifference(nearest.node, misfit.expected);
          return `${head}; nearest: ${actualNamed(nearest.node)}${detail === null ? "" : `, ${detail}`}`;
        }
        case "at-place":
          return `${head}; the child at that place is ${actualNamed(nearest.node)}`;
        case "deeper":
          return `${head}; nearest: ${actualNamed(nearest.node)}, which sits deeper than a child`;
        case "fits":
          return `${head}; nearest: ${actualNamed(nearest.node)}, which fits the line but an earlier line took it, or it sits out of the order the lines give`;
      }
    }
  }
}

/** Why an expected text is no tree a claim can be judged on: a text that
 * does not read (`line` names its line and how to write it), or a tree
 * that names no node, which every page holds. Either breaks the claim on
 * every page. */
export type ExpectedSnapshotProblem = { readonly kind: "unreadable"; readonly line: string } | { readonly kind: "names-nothing" };

/** The reason a claim breaks with for `problem`. Pure. */
export function expectedProblemReason(problem: ExpectedSnapshotProblem): string {
  return problem.kind === "unreadable"
    ? `the expected ARIA snapshot does not read: ${problem.line}`
    : "fits-aria-snapshot has an expected ARIA snapshot that names no node, which every page holds";
}

function expectedTree(expectedText: string): { readonly root: ExpectedNode } | { readonly problem: ExpectedSnapshotProblem } {
  const expected = readExpectedSnapshot(expectedText);
  if ("problem" in expected) return { problem: { kind: "unreadable", line: expected.problem } };
  return expected.named === 0 ? { problem: { kind: "names-nothing" } } : { root: expected.root };
}

/** Why an expected text breaks a claim on every page, or `null`: what
 * the check reports from the line alone, before a run. Pure. */
export function expectedSnapshotProblem(expectedText: string): ExpectedSnapshotProblem | null {
  const tree = expectedTree(expectedText);
  return "problem" in tree ? tree.problem : null;
}

/** Whether a claim's actual snapshot fits its expected one: the
 * compare's whole judgment, from the two texts the record keeps. An
 * expected text that is no tree, or names nothing, breaks the claim, since
 * the line states it. An actual text that does not read leaves the claim
 * unjudged: the browser printed something this reader does not know, which
 * says nothing about the page. Pure. */
export function judgeSnapshots(actualText: string, expectedText: string): { readonly fits: boolean } | { readonly broken: string } | { readonly unjudged: string } {
  const expected = expectedTree(expectedText);
  if ("problem" in expected) return { broken: expectedProblemReason(expected.problem) };
  const actual = readActualSnapshot(actualText);
  if ("problem" in actual) return { unjudged: `the ARIA snapshot nukadoko took does not read: ${actual.problem}, so the claim was not judged` };
  return { fits: snapshotFits(actual.root, expected.root) };
}

/** Where a broken claim's two snapshots part, as one line, or `null` when
 * they fit or either does not read (the claim's reason says why then).
 * Pure. */
export function snapshotDifference(actualText: string, expectedText: string): string | null {
  const misfit = misfitOf(actualText, expectedText);
  return misfit === null ? null : misfitText(misfit);
}

function misfitOf(actualText: string, expectedText: string): SnapshotMisfit | null {
  const expected = expectedTree(expectedText);
  const actual = readActualSnapshot(actualText);
  if ("problem" in expected || "problem" in actual) return null;
  return snapshotMisfit(actual.root, expected.root);
}

/** The most actual lines an excerpt shows. */
const EXCERPT_LINES = 12;

function lastLine(node: ActualNode): number {
  let last = node.line;
  for (const each of everyNode(node)) last = Math.max(last, each.line);
  return last;
}

/** The actual lines a misfit points at, so a line that cuts a long
 * snapshot shows where the fix goes, not the top of the page, which
 * `misfitText` names by line already: from the child the previous
 * expected sibling fit (or the node it was looked for under, for a first
 * child) to the nearest node, or with no node of its role, through the
 * children at its place; the end of the node with a child missing; or
 * the extra child. At most `EXCERPT_LINES` of them, kept at the end the
 * named node is on. `null` when the two fit, when either does not read,
 * or when the misfit names no actual line. Pure. */
export function snapshotExcerpt(actualText: string, expectedText: string): { readonly first: number; readonly last: number; readonly text: string } | null {
  const misfit = misfitOf(actualText, expectedText);
  if (misfit === null) return null;
  const span = ((): { readonly from: number; readonly to: number; readonly keep: "start" | "end" } | null => {
    switch (misfit.kind) {
      case "missing":
        return { from: misfit.inside.line, to: lastLine(misfit.inside), keep: "end" };
      case "extra":
        return { from: misfit.actual.line, to: misfit.extra.line, keep: "end" };
      case "unmatched": {
        const start = misfit.after?.line ?? misfit.inside?.line;
        if (misfit.nearest !== null) {
          const lines = [start ?? misfit.nearest.node.line, misfit.nearest.node.line];
          return { from: Math.min(...lines), to: Math.max(...lines), keep: "end" };
        }
        const [first] = misfit.place;
        if (first !== undefined) return { from: start ?? first.line, to: lastLine(misfit.place.at(-1)!), keep: "start" };
        return misfit.inside === null ? null : { from: misfit.inside.line, to: lastLine(misfit.inside), keep: "start" };
      }
    }
  })();
  if (span === null) return null;
  const from = Math.max(1, span.from);
  const first = span.keep === "end" ? Math.max(from, span.to - EXCERPT_LINES + 1) : from;
  const last = span.keep === "end" ? span.to : Math.min(span.to, from + EXCERPT_LINES - 1);
  const text = actualText
    .split(/\r?\n/)
    .slice(first - 1, last)
    .map(sourceText)
    .join("\n");
  return { first, last, text };
}
