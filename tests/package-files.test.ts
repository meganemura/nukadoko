import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/fixtures.js";

// Responsibility: what an agent reads inside node_modules/nukadoko is in the
// tarball, and every relative link it follows lands on a file that is in the
// tarball too. The truth is `npm pack --dry-run --json`, the same file list
// `npm publish` sends.

/** Relative link targets of the Markdown links in `text`, fenced blocks and
 * code spans left out, each without its `#fragment`. A URL with a scheme and
 * a link to a heading of the same file are not file links. */
function relativeLinks(text: string): string[] {
  const prose = text.replace(/^ *(```|~~~)[^\n]*\n[\s\S]*?^ *\1 *$/gm, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#"))
    .map((target) => decodeURIComponent(target.split("#")[0]!));
}

/** Where a link from `from` lands, as a package-relative path, or null when it
 * leaves the package. */
function resolveLink(from: string, target: string): string | null {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), target)).replace(/\/$/, "");
  return resolved === ".." || resolved.startsWith("../") ? null : resolved;
}

function packedFiles(): string[] {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return (JSON.parse(output) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((file) => file.path);
}

function markdownUnder(dir: string): string[] {
  return readdirSync(path.join(repoRoot, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.posix.join(path.relative(repoRoot, entry.parentPath).split(path.sep).join("/"), entry.name));
}

// docs/releasing.md is for whoever cuts a release, from a checkout, where the
// workflow it links to exists. An installed package has no `.github/`.
const REPOSITORY_ONLY_LINKS = new Set([
  "docs/releasing.md -> .github/workflows/publish.yml",
  "docs/releasing.ja.md -> .github/workflows/publish.yml",
]);

const packed = packedFiles();
const packedSet = new Set(packed);
const isPacked = (target: string) => packedSet.has(target) || packed.some((file) => file.startsWith(`${target}/`));

describe("the packed file list", () => {
  it("holds llms.txt, both skills with every reference, and the docs an agent is pointed at", () => {
    const required = [
      "llms.txt",
      "README.md",
      "CHANGELOG.md",
      "docs/spec.md",
      "docs/ci.md",
      "docs/upgrading.md",
      "docs/migration.md",
      "docs/migration-playwright-test.md",
      ...markdownUnder("skills"),
    ];
    expect(required.filter((file) => !packedSet.has(file))).toEqual([]);
    expect(required).toContain("skills/nukadoko/references/running.md");
  });

  it("every relative link in llms.txt and in a packed Markdown file lands on a packed file", () => {
    const sources = packed.filter((file) => file === "llms.txt" || (file.endsWith(".md") && !file.startsWith("src/")));
    const dead = sources.flatMap((source) =>
      relativeLinks(readFileSync(path.join(repoRoot, source), "utf8")).flatMap((target) => {
        const resolved = resolveLink(source, target);
        if (resolved !== null && REPOSITORY_ONLY_LINKS.has(`${source} -> ${resolved}`)) return [];
        return resolved !== null && isPacked(resolved) ? [] : [`${source} -> ${target}`];
      }),
    );
    expect(dead).toEqual([]);
  });

  it("names each repository-only link exception that still exists", () => {
    const present = [...REPOSITORY_ONLY_LINKS].filter((entry) => {
      const [source, target] = entry.split(" -> ") as [string, string];
      return relativeLinks(readFileSync(path.join(repoRoot, source), "utf8")).some(
        (link) => resolveLink(source, link) === target,
      );
    });
    expect(present).toEqual([...REPOSITORY_ONLY_LINKS]);
  });
});

describe("relativeLinks", () => {
  it("reads a link's file part and skips URLs, fragments, code spans, and fences", () => {
    const text = [
      "See [the skill](skills/nukadoko/SKILL.md) and [CI](docs/ci.md#the-job).",
      "[site](https://example.com) [top](#install) `[not](a.md)`",
      "```",
      "[fenced](b.md)",
      "```",
      '[titled](docs/spec.md "The spec") [spaced](docs/a%20b.md)',
    ].join("\n");
    expect(relativeLinks(text)).toEqual(["skills/nukadoko/SKILL.md", "docs/ci.md", "docs/spec.md", "docs/a b.md"]);
  });
});

describe("resolveLink", () => {
  it("resolves against the linking file's directory", () => {
    expect(resolveLink("skills/nukadoko/SKILL.md", "references/running.md")).toBe("skills/nukadoko/references/running.md");
    expect(resolveLink("docs/releasing.md", "../.github/workflows/publish.yml")).toBe(".github/workflows/publish.yml");
    expect(resolveLink("llms.txt", "skills/")).toBe("skills");
    expect(resolveLink("docs/spec.md", "../../outside.md")).toBeNull();
  });

  it("lands inside the package exactly when the walk up never passes the root", () =>
    hegel.test((tc) => {
      const segments = gs.arrays(gs.sampledFrom(["a", "b", ".."]), { minSize: 1, maxSize: 6 });
      const fromDir = tc.draw(gs.arrays(gs.sampledFrom(["x", "y"]), { maxSize: 3 }));
      const target = tc.draw(segments);
      let depth = fromDir.length;
      let escaped = false;
      for (const segment of target) {
        depth += segment === ".." ? -1 : 1;
        if (depth < 0) escaped = true;
      }
      const resolved = resolveLink([...fromDir, "file.md"].join("/"), target.join("/"));
      expect(resolved === null).toBe(escaped);
    }));
});
