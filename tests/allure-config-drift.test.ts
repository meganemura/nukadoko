import { describe, expect, it } from "vitest";
import { buildCategories } from "../src/report/allure/categories.js";
import { buildFailureMarker } from "../src/report/allure/map-scenario.js";
import type { ErrorKind } from "../src/receipt/types.js";

// Responsibility: examples/allure/allurerc.mjs is a hand-copied mirror of
// src/report/allure/categories.ts's own NAME_BY_KIND -- Allure 3 has no way
// to read that table itself (categories.ts writes Allure 2's
// categories.json, which Allure 3's generate/report never opens), so the
// two only stay honest if something re-checks them against each other.
// Without this test, a name or kind edited in one place but not the other
// would silently ship: the shipped example would still "work" (it's valid
// Allure 3 config), it would just quietly mis-name or drop a category for
// real users who copied it. This test only checks the two agree with each
// other; render-check-2.md is what established the config format itself
// (matchers/labels) actually gets read by `allure generate`.

const ALL_KINDS: readonly ErrorKind[] = [
  "args_invalid",
  "result_invalid",
  "binding_invalid",
  "world_invalid",
  "timeout",
  "unsupported",
  "step_error",
];

interface Allure3CategoryRule {
  name?: string;
  matchers?: Array<{ labels?: Record<string, string> }>;
  matchedStatuses?: unknown;
  messageRegex?: unknown;
  traceRegex?: unknown;
}

interface Allure3Config {
  categories: Allure3CategoryRule[];
}

// A non-literal specifier keeps tsc from trying (and failing) to resolve a
// declaration file for this plain-JS example -- it has none by design, the
// same as every other file under examples/.
const ALLURE_CONFIG_URL = new URL("../examples/allure/allurerc.mjs", import.meta.url).href;

async function loadExampleConfig(): Promise<Allure3Config> {
  const mod = (await import(ALLURE_CONFIG_URL)) as { default: Allure3Config };
  return mod.default;
}

/** categories.ts's own rules carry a `messageRegex` built from
 * `buildFailureMarker(kind)`, not the kind itself -- recover each rule's
 * kind by finding which kind's own marker its regex was built from, the
 * same technique tests/allure-categories.test.ts already uses. */
function nameByKindFromEngine(): Record<ErrorKind, string> {
  const rules = buildCategories();
  const result = {} as Record<ErrorKind, string>;
  for (const kind of ALL_KINDS) {
    const marker = buildFailureMarker(kind);
    const rule = rules.find((r) => typeof r.messageRegex === "string" && r.messageRegex.startsWith(escapeForTest(marker)));
    expect(rule, `categories.ts has no rule for kind ${kind}`).toBeDefined();
    result[kind] = rule?.name ?? "";
  }
  return result;
}

function escapeForTest(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("examples/allure/allurerc.mjs vs src/report/allure/categories.ts", () => {
  it("has exactly seven rules, same count as buildCategories()", async () => {
    const config = await loadExampleConfig();
    expect(config.categories).toHaveLength(7);
    expect(config.categories).toHaveLength(buildCategories().length);
  });

  it("uses the matchers/labels key on every rule, never the legacy compat keys", async () => {
    // Mixing `matchers` with `matchedStatuses`/`messageRegex`/`traceRegex`
    // on the same rule throws at `allure generate` time
    // (@allurereport/core-api/dist/categories.js:64-70, per render-check-2.md).
    const config = await loadExampleConfig();
    for (const rule of config.categories) {
      expect(rule.matchers, `rule ${rule.name} is missing matchers`).toBeDefined();
      expect(rule.matchedStatuses, `rule ${rule.name} mixes in legacy matchedStatuses`).toBeUndefined();
      expect(rule.messageRegex, `rule ${rule.name} mixes in legacy messageRegex`).toBeUndefined();
      expect(rule.traceRegex, `rule ${rule.name} mixes in legacy traceRegex`).toBeUndefined();
    }
  });

  it("each rule's nukadoko.failure label value is one of ErrorKind's seven, no duplicates, none missing", async () => {
    const config = await loadExampleConfig();
    const kinds = config.categories.map((rule) => rule.matchers?.[0]?.labels?.["nukadoko.failure"]);
    for (const kind of kinds) {
      expect(kind, `rule missing a matchers[0].labels["nukadoko.failure"] value`).toBeDefined();
    }
    expect(new Set(kinds)).toEqual(new Set(ALL_KINDS));
    expect(kinds).toHaveLength(ALL_KINDS.length);
  });

  it("the name set matches src/report/allure/categories.ts exactly", async () => {
    const config = await loadExampleConfig();
    const configNames = new Set(config.categories.map((rule) => rule.name));
    const engineNames = new Set(buildCategories().map((rule) => rule.name));
    expect(configNames).toEqual(engineNames);
  });

  it("each rule names the same category as buildCategories() for its own kind", async () => {
    const config = await loadExampleConfig();
    const engineNameByKind = nameByKindFromEngine();
    for (const rule of config.categories) {
      const kind = rule.matchers?.[0]?.labels?.["nukadoko.failure"] as ErrorKind | undefined;
      expect(kind, `rule ${rule.name} has no recoverable kind`).toBeDefined();
      if (kind) {
        expect(rule.name).toBe(engineNameByKind[kind]);
      }
    }
  });
});
