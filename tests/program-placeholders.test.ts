import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { urlPort, type ProgramRecipe, type TimedCommand } from "../src/config/program-schema.js";
import {
  conditionOutsideEnvironmentsFix,
  fillPlaceholders,
  PLACEHOLDER_NAMES,
  placeholderGapFix,
  placeholderGaps,
  placeholderRefusal,
  type PlaceholderName,
  type PlaceholderValues,
} from "../src/program/placeholders.js";

// Responsibility: src/program/placeholders.ts, the one rule that fills
// `{port}`, `{url}`, `{dir}`, `{root}`, `{world}`, `{token}`, and
// `{events}` in a program file's commands and env, and names each one a
// world has no value for from its recipe alone: every world with a URL
// has `{port}`, the one `serve` got or the URL's, and only a world
// nukadoko serves has `{events}`.

// Literal text, braces included. Its alphabet cannot spell a placeholder
// name, so two pieces side by side never spell one between them.
const literal = gs.text({ alphabet: "ab {}:/-", maxSize: 6 });
const placeholder = gs.sampledFrom(PLACEHOLDER_NAMES);
// A value cannot spell a placeholder either, so the expected text is the
// pieces joined.
const value = gs.text({ alphabet: "xyz0189:/._-", maxSize: 8 });

describe("fillPlaceholders", () => {
  it("replaces every placeholder with its value and leaves the text between them as written", () =>
    hegel.test((tc) => {
      const pieces = tc.draw(gs.arrays(gs.tuples(literal, placeholder), { maxSize: 4 }));
      const tail = tc.draw(literal);
      const values = Object.fromEntries(PLACEHOLDER_NAMES.map((name) => [name, tc.draw(value)])) as Record<PlaceholderName, string>;
      const text = `${pieces.map(([before, name]) => `${before}{${name}}`).join("")}${tail}`;
      const expected = `${pieces.map(([before, name]) => `${before}${values[name]}`).join("")}${tail}`;
      expect(fillPlaceholders(text, values)).toEqual({ text: expected });
    }));

  it("leaves text with no placeholder unchanged, a JSON object or a shell brace included", () =>
    hegel.test((tc) => {
      const text = tc.draw(literal);
      expect(fillPlaceholders(text, {})).toEqual({ text });
    }));

  it("names the first placeholder that has no value, and never fills it with an empty string", () =>
    hegel.test((tc) => {
      const names = tc.draw(gs.arrays(placeholder, { minSize: 1, maxSize: 4 }));
      const known = new Set(tc.draw(gs.arrays(placeholder, { maxSize: 6 })));
      const values = Object.fromEntries([...known].map((name) => [name, "v"]));
      const text = names.map((name) => `-{${name}}`).join(" ");
      const firstMissing = names.find((name) => !known.has(name));
      expect(fillPlaceholders(text, values)).toEqual(
        firstMissing === undefined ? { text: names.map(() => "-v").join(" ") } : { missing: firstMissing },
      );
    }));

  it("fills an exact example", () => {
    expect(fillPlaceholders("bin/rails server -p {port} --pid {dir}/server.pid {other}", { port: "41873", dir: "/w" })).toEqual({
      text: "bin/rails server -p 41873 --pid /w/server.pid {other}",
    });
    expect(fillPlaceholders("{url}/up", {})).toEqual({ missing: "url" });
  });
});

// A world of each kind, as `placeholderGaps` reads it.
const reachKind = gs.sampledFrom(["serve", "url", "none"] as const);
const reachOf = (kind: "serve" | "url" | "none"): ProgramRecipe["reach"] =>
  kind === "serve"
    ? { kind, serve: { command: "node server.js", port: "auto", ready: "/", timeout_ms: 60_000 } }
    : kind === "url"
      ? { kind, url: "http://a.example", timeout_ms: 60_000 }
      : { kind };
// A command as a recipe holds it, with its limit.
const timed = (command: string | readonly string[]): TimedCommand => ({ command, timeout_ms: 600_000 });
// The values a running world of `kind` fills, and a build's.
function valuesFor(kind: "serve" | "url" | "none" | "build"): PlaceholderValues {
  if (kind === "build") return { root: "/r" };
  return { root: "/r", dir: "/d", world: "w", token: "t", ...(kind === "none" ? {} : { port: "1", url: "u" }), ...(kind === "serve" ? { events: "/e" } : {}) };
}
const word = gs.tuples(literal, gs.arrays(placeholder, { maxSize: 2 })).map(([text, names]) => `${text}${names.map((name) => `{${name}}`).join("")}`);
const command = gs.arrays(word, { minSize: 1, maxSize: 3 });

describe("placeholderGaps", () => {
  it("names a field exactly when filling it as a world of its kind would leaves a placeholder unfilled, first gap first", () =>
    hegel.test((tc) => {
      const kind = tc.draw(reachKind);
      const build = tc.draw(gs.arrays(command, { maxSize: 2 }));
      const prepare = tc.draw(gs.arrays(command, { maxSize: 2 }));
      const env = Object.fromEntries(tc.draw(gs.arrays(gs.tuples(gs.sampledFrom(["A", "B", "C"]), word), { maxSize: 3 })));
      const lists = tc.draw(gs.arrays(command, { maxSize: 2 })).map((words, index) => ({ kind: (["routes", "flags"] as const)[index]!, ...timed(words) }));
      const reach = reachOf(kind);
      const gaps = placeholderGaps({ build: build.map(timed), prepare: prepare.map(timed), reach, lists, env });

      const fields: [string, readonly string[], "serve" | "url" | "none" | "build"][] = [
        ...build.map((words, index): [string, readonly string[], "build"] => [`build[${index}]`, words, "build"]),
        ...prepare.map((words, index): [string, readonly string[], typeof kind] => [`prepare[${index}]`, words, kind]),
        ...(kind === "serve" ? [["serve.command", ["node", "server.js"], kind] as [string, readonly string[], typeof kind]] : []),
        // A list runs only in a world nukadoko serves.
        ...(kind === "serve" ? lists.map((list): [string, readonly string[], typeof kind] => [`lists.${list.kind}`, list.command as readonly string[], kind]) : []),
        ...Object.entries(env).map(([key, value]): [string, readonly string[], typeof kind] => [`env.${key}`, [value], kind]),
      ];
      for (const [where, words, fieldKind] of fields) {
        const missing = words.map((text) => fillPlaceholders(text, valuesFor(fieldKind))).find((filled) => "missing" in filled);
        const own = gaps.filter((gap) => gap.where === where);
        expect(own.length > 0).toBe(missing !== undefined);
        if (missing !== undefined && "missing" in missing) expect(own[0]!.name).toBe(missing.missing);
        expect(new Set(own.map((gap) => gap.name)).size).toBe(own.length);
      }
      expect(gaps.every((gap) => fields.some(([where]) => where === gap.where))).toBe(true);
    }));

  it("names each gap of a program with no URL, and the refusal names every world's", () => {
    const recipe = { build: [timed(["node", "-e", "{root} {port}"])], prepare: [timed(["node", "-e", "x"]), timed("echo {port}")], reach: reachOf("url"), env: { BASE: "{url}" } };
    // A url world has a port: only the build lacks one.
    expect(placeholderGaps(recipe)).toEqual([{ where: "build[0]", name: "port", why: "build runs once per tree, before any world exists" }]);
    expect(placeholderGaps({ ...recipe, build: [], reach: reachOf("none") })).toEqual([
      { where: "prepare[1]", name: "port", why: "this world has neither serve nor url" },
      { where: "env.BASE", name: "url", why: "this world has neither serve nor url" },
    ]);
    expect(placeholderRefusal([{ name: "default", recipe: { ...recipe, reach: reachOf("none") } }, { name: "local", recipe: { ...recipe, reach: reachOf("serve") } }], "nukadoko.program.ts", {})).toEqual({
      message:
        "world default: build[0] names {port}, which has no value here: build runs once per tree, before any world exists; " +
        "world default: prepare[1] names {port}, which has no value here: this world has neither serve nor url; " +
        "world default: env.BASE names {url}, which has no value here: this world has neither serve nor url; " +
        "world local: build[0] names {port}, which has no value here: build runs once per tree, before any world exists; nothing ran",
      fix: "Write only {root} in build[0] of nukadoko.program.ts, or move the command to prepare, which runs once per world.",
      first: { world: "default", gap: { where: "build[0]", name: "port", why: "build runs once per tree, before any world exists" } },
    });
    expect(placeholderRefusal([{ name: "local", recipe: { ...recipe, build: [], reach: reachOf("serve") } }], "nukadoko.program.ts", {})).toBeUndefined();
  });

  it("fixes a gap by naming only what the world lacks, for each kind of world", () =>
    hegel.test((tc) => {
      const kind = tc.draw(reachKind);
      const name = tc.draw(placeholder);
      const recipe = { build: [timed(`make {${name}}`)], prepare: [timed(`seed {${name}}`)], reach: reachOf(kind), env: {} };
      const fixes = placeholderGaps(recipe).map((gap) => placeholderGapFix(gap, "w", "nukadoko.program.ts", {}));
      for (const fix of fixes) {
        if (fix.includes("build[0]")) expect(fix).toBe("Write only {root} in build[0] of nukadoko.program.ts, or move the command to prepare, which runs once per world.");
        else if (name === "events") {
          const edit = kind === "url" ? "serve world w in place of its url" : "give world w serve";
          expect(fix).toBe(`Remove {events} from prepare[0] of nukadoko.program.ts, or ${edit}: nukadoko makes the events file only for a program it starts.`);
        }
        else expect(fix).toBe(`Remove {${name}} from prepare[0] of nukadoko.program.ts, or give world w serve or url.`);
      }
      // A world that serves or has a url is never told to add the other,
      // which the file refuses beside it; {events} has a value only where
      // nukadoko serves, so a url world is told to serve in place of it.
      expect(fixes.some((fix) => fix.includes("prepare[0]"))).toBe((kind === "none" && (name === "port" || name === "url")) || (kind !== "serve" && name === "events"));
    }));
});

describe("urlPort", () => {
  it("is the port a URL writes, or its scheme's", () =>
    hegel.test((tc) => {
      const scheme = tc.draw(gs.sampledFrom(["http", "https"] as const));
      const host = tc.draw(gs.sampledFrom(["localhost", "127.0.0.1", "a.example", "[::1]"]));
      const port = tc.draw(gs.oneOf<number | undefined>(gs.just(undefined), gs.integers({ minValue: 1, maxValue: 65_535 })));
      const rest = tc.draw(gs.sampledFrom(["", "/", "/app?x=1"]));
      const url = `${scheme}://${host}${port === undefined ? "" : `:${port}`}${rest}`;
      expect(urlPort(url)).toBe(port ?? (scheme === "https" ? 443 : 80));
    }));
});

describe("{condition.<name>}", () => {
  const conditionName = gs.sampledFrom(["banner", "locale", "a.b-c_1"]);
  const declared = gs
    .arrays(gs.tuples(conditionName, gs.oneOf(gs.booleans().map((b): boolean | string => b), gs.sampledFrom<boolean | string>(["ja", "x"]))), { maxSize: 3 })
    .map((entries) => Object.fromEntries(entries));

  it("fills the environment's own value as text, and has none for a condition it does not declare", () =>
    hegel.test((tc) => {
      const name = tc.draw(conditionName);
      const conditions = tc.draw(gs.optional(declared)) ?? undefined;
      const filled = fillPlaceholders(`BANNER={condition.${name}}`, { conditions });
      const value = conditions !== undefined && Object.hasOwn(conditions, name) ? conditions[name] : undefined;
      expect(filled).toEqual(value === undefined ? { missing: `condition.${name}` } : { text: `BANNER=${String(value)}` });
    }));

  it("is a gap in a world whose environment does not declare the condition, and in every build", () =>
    hegel.test((tc) => {
      const name = tc.draw(conditionName);
      const conditions = tc.draw(gs.optional(declared)) ?? undefined;
      const inBuild = tc.draw(gs.booleans());
      const env: Record<string, string> = inBuild ? {} : { FLAG: `{condition.${name}}` };
      const recipe = {
        build: inBuild ? [timed(`make FLAG={condition.${name}}`)] : [],
        prepare: [],
        reach: reachOf(tc.draw(reachKind)),
        env,
        conditions,
      };
      const isDeclared = conditions !== undefined && Object.hasOwn(conditions, name);
      expect(placeholderGaps(recipe)).toEqual(
        inBuild
          ? [{ where: "build[0]", name: `condition.${name}`, why: "build runs once per tree, before any world exists" }]
          : isDeclared
            ? []
            : [{ where: "env.FLAG", name: `condition.${name}`, why: `its environment declares no condition "${name}" under conditions` }],
      );
    }));

  it("sends a gap outside the environments to the first environment that declares the condition, and to none when none does", () =>
    hegel.test((tc) => {
      const name = tc.draw(conditionName);
      const environments = Object.fromEntries(
        tc.draw(gs.arrays(gs.tuples(gs.sampledFrom(["on", "off", "staging"]), gs.optional(declared)), { maxSize: 3 })).map(([env, conditions]) => [env, conditions === null ? {} : { conditions }]),
      );
      const gap = { where: "env.FLAG", name: `condition.${name}` as const, why: "" };
      const outside = conditionOutsideEnvironmentsFix(gap, environments, "nukadoko.program.ts");
      expect(placeholderGapFix(gap, "default", "nukadoko.program.ts", environments)).toBe(outside?.fix);
      for (const env of Object.keys(environments)) {
        expect(placeholderGapFix(gap, env, "nukadoko.program.ts", environments)).toBe(`Declare ${name} under conditions of world ${env} in nukadoko.program.ts, or remove {condition.${name}} from env.FLAG.`);
      }
      const declaring = Object.entries(environments)
        .filter(([, environment]) => environment.conditions !== undefined && Object.hasOwn(environment.conditions, name))
        .map(([env]) => env);
      expect(outside?.environment).toBe(declaring[0]);
      for (const env of declaring) expect(outside?.fix).toContain(env);
      expect(outside?.fix).toContain(`remove {condition.${name}} from env.FLAG`);
    }));

  it("leaves a gap that is not a condition, or is in a build, to placeholderGapFix", () => {
    const environments = { on: { conditions: { banner: true } } };
    expect(conditionOutsideEnvironmentsFix({ where: "env.PORT", name: "port", why: "" }, environments, "nukadoko.program.ts")).toBeUndefined();
    expect(conditionOutsideEnvironmentsFix({ where: "build[0]", name: "condition.banner", why: "" }, environments, "nukadoko.program.ts")).toBeUndefined();
  });

  it("leaves a brace that only looks like one as written", () => {
    expect(fillPlaceholders("{condition.} {condition} {conditions.a}", { conditions: { a: true } })).toEqual({ text: "{condition.} {condition} {conditions.a}" });
  });
});
