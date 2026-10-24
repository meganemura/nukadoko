import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { programSchema, type Program } from "../src/config/program-schema.js";
import { configSchema, type NukadokoConfig } from "../src/config/schema.js";
import { UnknownEnvironmentError } from "../src/environment/errors.js";
import { resolveEnvironment, type ResolvedEnvironment } from "../src/environment/resolve-environment.js";

// Responsibility: resolve-environment.ts's own layering/unknown-name logic
// in isolation (the program's url layered by environment, envFiles append
// order, unknown env fails setup), separate from environment.test.ts's
// end-to-end `nuka do` wiring so a layering mistake and a wiring mistake
// fail different tests.

function parseConfig(input: unknown): NukadokoConfig {
  return configSchema.parse(input);
}

function parseProgram(input: unknown): Program {
  return programSchema.parse(input);
}

/** The url an environment's world reaches, when it names one. */
function urlOf(resolved: ResolvedEnvironment): unknown {
  const reach = resolved.program?.reach;
  return reach?.kind === "url" ? reach.url : undefined;
}

describe("resolveEnvironment", () => {
  it("overrides the top-level url with the environment's own", () => {
    const program = parseProgram({
      url: "http://top.example",
      environments: { staging: { url: "http://staging.example" } },
    });

    expect(urlOf(resolveEnvironment(parseConfig({}), program, "staging", true))).toBe("http://staging.example");
  });

  it("falls back to the top-level url when the environment sets none", () => {
    const program = parseProgram({ url: "http://top.example", environments: { staging: {} } });

    expect(urlOf(resolveEnvironment(parseConfig({}), program, "staging", true))).toBe("http://top.example");
  });

  it("appends envFiles: the config's first, then the environment's own", () => {
    const config = parseConfig({ envFiles: [".env", ".env.local"] });
    const program = parseProgram({ environments: { staging: { envFiles: [".env.staging"] } } });

    expect(resolveEnvironment(config, program, "staging", true).envFiles).toEqual([".env", ".env.local", ".env.staging"]);
  });

  it("resolves an empty envFiles list when neither the config nor the environment set one", () => {
    const program = parseProgram({ environments: { staging: {} } });

    expect(resolveEnvironment(parseConfig({}), program, "staging", true).envFiles).toEqual([]);
  });

  it("resolves no program, and only the config's envFiles, when the tree has no program file", () => {
    const resolved = resolveEnvironment(parseConfig({ envFiles: [".env"] }), null, "default", false);
    expect(resolved).toEqual({ name: "default", envFiles: [".env"], policy: undefined, version: undefined, program: null });
  });

  it("throws UnknownEnvironmentError for an explicit --env name with no matching entry", () => {
    expect(() => resolveEnvironment(parseConfig({}), null, "no-such-env", true)).toThrow(UnknownEnvironmentError);
    expect(() => resolveEnvironment(parseConfig({}), parseProgram({}), "no-such-env", true)).toThrow(
      'Unknown environment "no-such-env": not defined in nukadoko.program.ts\'s "environments"',
    );
  });

  it("does not throw for the implicit default name even when environments.default is undefined", () => {
    const resolved = resolveEnvironment(parseConfig({}), parseProgram({}), "default", false);
    expect(resolved.name).toBe("default");
    expect(resolved.policy).toBeUndefined();
    expect(resolved.version).toBeUndefined();
  });

  it("resolves environments.default when it is defined, implicit or explicit", () => {
    const program = parseProgram({ environments: { default: { url: "http://default.example" } } });

    expect(urlOf(resolveEnvironment(parseConfig({}), program, "default", false))).toBe("http://default.example");
    expect(urlOf(resolveEnvironment(parseConfig({}), program, "default", true))).toBe("http://default.example");
  });

  it("resolves policy and version only from the environment, undefined when absent", () => {
    const version = () => "1.2.3";
    const program = parseProgram({ environments: { locked: { policy: "read-only", version }, open: {} } });

    const locked = resolveEnvironment(parseConfig({}), program, "locked", true);
    expect(locked.policy).toBe("read-only");
    expect(locked.version).toBe(version);

    const open = resolveEnvironment(parseConfig({}), program, "open", true);
    expect(open.policy).toBeUndefined();
    expect(open.version).toBeUndefined();
  });

  // Object.prototype's own names match the environment-name pattern, and a
  // bracket read finds them on every plain object. They are not entries the
  // program file defined. An own entry with one of those names still is.
  it("rejects an inherited name such as toString or constructor, and still resolves an own name", () => {
    const config = parseConfig({});
    const program = parseProgram({
      url: "http://top.example",
      environments: {
        staging: { url: "http://staging.example" },
        constructor: { url: "http://ctor.example" },
      },
    });

    expect(urlOf(resolveEnvironment(config, program, "staging", true))).toBe("http://staging.example");
    expect(urlOf(resolveEnvironment(config, program, "constructor", true))).toBe("http://ctor.example");

    const bare = parseProgram({ url: "http://top.example", environments: { staging: { url: "http://staging.example" } } });
    expect(() => resolveEnvironment(config, bare, "constructor", true)).toThrow(UnknownEnvironmentError);
    expect(() => resolveEnvironment(config, bare, "toString", true)).toThrow(UnknownEnvironmentError);
    expect(() => resolveEnvironment(config, bare, "__proto__", true)).toThrow(UnknownEnvironmentError);
    expect(urlOf(resolveEnvironment(config, bare, "staging", true))).toBe("http://staging.example");
  });
});

// Every name Object.prototype actually owns that the environment-name
// pattern accepts. A generator of arbitrary strings almost never hits
// these, which is how a bracket read of `environments` kept treating
// them as defined entries.
const inheritedEnvironmentNames = Object.getOwnPropertyNames(Object.prototype).filter((name) =>
  /^[a-z0-9_-]+$/.test(name),
);

const ownEnvironmentName = gs.text({
  alphabet: "abcdefghijklmnopqrstuvwxyz0123456789_-",
  minSize: 1,
  maxSize: 12,
});

describe("resolveEnvironment inherited names", () => {
  it("treats only an own environments entry as that environment", () =>
    hegel.test((tc) => {
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: inheritedEnvironmentNames.length - 1 }));
      const inherited = inheritedEnvironmentNames[index];
      if (inherited === undefined) {
        throw new Error("inherited environment name index was out of range");
      }
      const ownName = tc.draw(ownEnvironmentName);
      const ownBase = `http://${ownName}.example`;
      const config = parseConfig({});
      const program = parseProgram({
        url: "http://top.example",
        environments: {
          staging: { url: "http://staging.example" },
          [ownName]: { url: ownBase },
        },
      });

      // Copying a record assigns each key. Assigning "__proto__" runs the
      // prototype setter, so that name is not an own entry after parse.
      // Only a key the parsed object still owns is an environment.
      const environments = program.environments ?? {};
      if (Object.hasOwn(environments, ownName)) {
        expect(urlOf(resolveEnvironment(config, program, ownName, true))).toBe(ownBase);
      } else {
        expect(() => resolveEnvironment(config, program, ownName, true)).toThrow(UnknownEnvironmentError);
      }
      expect(urlOf(resolveEnvironment(config, program, "staging", true))).toBe("http://staging.example");

      if (Object.hasOwn(environments, inherited)) {
        expect(urlOf(resolveEnvironment(config, program, inherited, true))).toBe(`http://${inherited}.example`);
      } else {
        expect(() => resolveEnvironment(config, program, inherited, true)).toThrow(UnknownEnvironmentError);
      }
    }));
});
