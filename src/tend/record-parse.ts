import { readdirSync } from "node:fs";
import path from "node:path";

// Responsibility: the read side of src/accept/render-record.ts — that file
// is the only writer of acceptance records, so this module exists to walk a
// project for candidate record files and turn one record's raw text back
// into the fields signoff-rot.ts needs to judge (docs/spec.md "Tending"'s
// first finding). Boundary: this module never touches the vocabulary,
// feature files, or current step contracts — it only knows how to find and
// decode a record file's own text. Judging whether what it decoded is still
// true is signoff-rot.ts's job, kept separate so a parsing bug and a
// judgment bug are never the same diff.
//
// Discovery walks the whole project, not just featuresDir (src/cli/
// accept.ts's own header: an acceptance feature is recommended to live
// outside featuresDir, so its record can be anywhere too) — a `.md` file is
// only treated as a record once its own frontmatter carries all four of
// `run_id`/`commit`/`feature`/`scenarios` (this task's spec: the condition
// that keeps an ordinary README from being mistaken for one, deliberately
// not loosened).
//
// No YAML library is added for this (project rule: no new dependency
// without sign-off, and this task's own spec repeats it for YAML
// specifically) — `render-record.ts`'s own `yamlScalar` only ever quotes a
// value with `JSON.stringify`, never any other YAML quoting style, so
// "is this value quoted" reduces to "does it start with `\"`", and decoding
// it is exactly `JSON.parse`. That is the one and only YAML shape this
// module needs to read back, so a line-oriented reader is the correct match
// for the writer, not a shortcut around a real parser.

const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", ".nukadoko", "dist"]);

function walkMarkdownFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable directory (permissions, or removed mid-walk) — nothing to
    // find, not a reason to fail the rest of the walk.
    return [];
  }

  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      files.push(...walkMarkdownFiles(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

/** Every `.md` file under `rootDir`, absolute paths, excluding
 * `node_modules`/`.git`/`.nukadoko`/`dist`. Not yet filtered by frontmatter
 * shape — `parseAcceptanceRecord` below does that, since telling "not a
 * record" apart from "a record, but broken" needs the file's own content. */
export function discoverMarkdownFiles(rootDir: string): string[] {
  return walkMarkdownFiles(rootDir);
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/;
const REQUIRED_FRONTMATTER_KEYS = ["run_id", "commit", "feature", "scenarios"] as const;

function looksLikeRecordFrontmatter(frontmatterBody: string): boolean {
  return REQUIRED_FRONTMATTER_KEYS.every((key) => new RegExp(`^${key}:`, "m").test(frontmatterBody));
}

// `yamlScalar`'s own inverse: unquoted iff `needsYamlQuoting` said no, in
// which case the value is exactly the rest of the line (that function
// already refuses to leave leading/trailing whitespace or a line break
// unquoted). Quoted values are always produced by `JSON.stringify`, never
// hand-assembled, so `JSON.parse` is the exact, sufficient inverse — not an
// approximation of one.
function decodeFeatureValue(raw: string): string | undefined {
  if (!raw.startsWith('"')) {
    return raw;
  }
  try {
    return JSON.parse(raw) as string;
  } catch {
    return undefined;
  }
}

function extractGherkinFence(body: string): string | undefined {
  const headingIndex = body.indexOf("## The scenario as it ran");
  if (headingIndex === -1) return undefined;
  // Searches only after the heading, and stops at the first closing fence
  // (matching tests/accept.test.ts's own `jsonCodeBlocks` convention for the
  // same file) — a Gherkin line that itself begins with a bare "```" would
  // defeat this, but Gherkin has no construct that produces one, so this is
  // a boundary this module accepts rather than solves.
  const match = /```gherkin\n([\s\S]*?)\n```/.exec(body.slice(headingIndex));
  return match?.[1];
}

/** One `#### <step text>` fence this record embeds, narrowed to the shape a
 * receipt has and a hook record does not (`render-record.ts`'s own
 * `renderHook` emits `{ type, status, ... }` — no `step` key — so filtering
 * on `step` being a string is what tells a step's own receipt block apart
 * from a hook's, without needing to parse the preceding heading text at
 * all). */
export interface RecordReceiptLike {
  readonly step: string;
  readonly status: unknown;
  readonly result?: unknown;
}

function isReceiptLike(value: unknown): value is RecordReceiptLike {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).step === "string" &&
    "status" in value
  );
}

function extractReceiptLikeBlocks(body: string): { ok: true; receipts: RecordReceiptLike[] } | { ok: false; reason: string } {
  const pattern = /```json\n([\s\S]*?)\n```/g;
  const receipts: RecordReceiptLike[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]!);
    } catch (error) {
      return {
        ok: false,
        reason: `a fenced JSON block is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (isReceiptLike(parsed)) {
      receipts.push(parsed);
    }
    // Otherwise a hook's own JSON block (no `step` key) — not this module's
    // concern; render-record.ts's `renderHook` is the only other producer of
    // a json-fenced block in a record.
  }
  return { ok: true, receipts };
}

export interface ParsedAcceptanceRecord {
  /** rootDir-relative path to the record file itself. */
  readonly relativePath: string;
  /** rootDir-relative path to the feature this record froze — exactly the
   * frontmatter's own `feature:` value, decoded. */
  readonly featurePath: string;
  /** The frozen feature source, already trailing-newline-normalized the same
   * way `render-record.ts` normalizes it before embedding — a caller
   * comparing this against a freshly-read feature file must apply the same
   * `.replace(/\n$/, "")` to that file's text before comparing. */
  readonly featureSource: string;
  /** Every step-shaped receipt this record embeds, in document order. */
  readonly receipts: readonly RecordReceiptLike[];
}

export type RecordParseResult =
  | { readonly kind: "not-a-record" }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "ok"; readonly record: ParsedAcceptanceRecord };

/**
 * Parses one already-read `.md` file's text. `relativePath` is carried
 * through only for the returned record's own identity — this function does
 * no filesystem access itself.
 *
 * Three outcomes, not two, on purpose (this task's spec: a record that
 * fails to parse must be reported, not silently skipped, or a broken record
 * would read as a healthy one by omission): `"not-a-record"` for ordinary
 * Markdown that never claimed to be a record at all (no `errors` entry —
 * this is the expected case for every non-record `.md` file in a project),
 * `"malformed"` once the frontmatter shape has already claimed record-ness
 * but something inside it can't be decoded, and `"ok"` with the decoded
 * fields.
 */
export function parseAcceptanceRecord(content: string, relativePath: string): RecordParseResult {
  const frontmatterMatch = FRONTMATTER_PATTERN.exec(content);
  if (!frontmatterMatch) {
    return { kind: "not-a-record" };
  }
  const frontmatterBody = frontmatterMatch[1]!;
  if (!looksLikeRecordFrontmatter(frontmatterBody)) {
    return { kind: "not-a-record" };
  }

  const featureLineMatch = /^feature: (.*)$/m.exec(frontmatterBody);
  if (!featureLineMatch) {
    return { kind: "malformed", reason: "frontmatter has no feature: value" };
  }
  const featurePath = decodeFeatureValue(featureLineMatch[1]!);
  if (featurePath === undefined) {
    return { kind: "malformed", reason: "frontmatter's feature: value could not be decoded" };
  }

  const body = content.slice(frontmatterMatch[0].length);
  const featureSource = extractGherkinFence(body);
  if (featureSource === undefined) {
    return { kind: "malformed", reason: 'missing the "## The scenario as it ran" fenced feature source' };
  }

  const receiptsResult = extractReceiptLikeBlocks(body);
  if (!receiptsResult.ok) {
    return { kind: "malformed", reason: receiptsResult.reason };
  }

  return {
    kind: "ok",
    record: { relativePath, featurePath, featureSource, receipts: receiptsResult.receipts },
  };
}
