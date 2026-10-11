import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { configSchema, type NukadokoConfig } from "../src/config/schema.js";
import { UnknownEnvironmentError } from "../src/environment/errors.js";
import { resolveEnvironment } from "../src/environment/resolve-environment.js";

// Responsibility: resolve-environment.ts's own layering/unknown-name logic
// in isolation (baseURL override /
// envFiles append order / unknown env fails setup), separate from
// environment.test.ts's end-to-end `nuka do` wiring so a layering mistake
// and a wiring mistake fail different tests.

function parseConfig(input: unknown): NukadokoConfig {
  const result = configSchema.parse(input);
  return result;
}

describe("resolveEnvironment", () => {
  it("overrides the top-level baseURL with the environment's own", () => {
    const config = parseConfig({
      baseURL: "http://top.example",
      environments: { staging: { baseURL: "http://staging.example" } },
    });

    const resolved = resolveEnvironment(config, "staging", true);
    expect(resolved.baseURL).toBe("http://staging.example");
  });

  it("falls back to the top-level baseURL when the environment sets none", () => {
    const config = parseConfig({
      baseURL: "http://top.example",
      environments: { staging: {} },
    });

    const resolved = resolveEnvironment(config, "staging", true);
    expect(resolved.baseURL).toBe("http://top.example");
  });

  it("appends envFiles — top-level first, then the environment's own", () => {
    const config = parseConfig({
      envFiles: [".env", ".env.local"],
      environments: { staging: { envFiles: [".env.staging"] } },
    });

    const resolved = resolveEnvironment(config, "staging", true);
    expect(resolved.envFiles).toEqual([".env", ".env.local", ".env.staging"]);
  });

  it("resolves an empty envFiles list when neither top-level nor the environment set one", () => {
    const config = parseConfig({ environments: { staging: {} } });

    const resolved = resolveEnvironment(config, "staging", true);
    expect(resolved.envFiles).toEqual([]);
  });

  it("throws UnknownEnvironmentError for an explicit --env name with no matching entry", () => {
    const config = parseConfig({});
    expect(() => resolveEnvironment(config, "no-such-env", true)).toThrow(
      UnknownEnvironmentError,
    );
  });

  it("does not throw for the implicit default name even when environments.default is undefined", () => {
    const config = parseConfig({});
    const resolved = resolveEnvironment(config, "default", false);
    expect(resolved.name).toBe("default");
    expect(resolved.policy).toBeUndefined();
    expect(resolved.version).toBeUndefined();
  });

  it("resolves environments.default when it is configured, implicit or explicit", () => {
    const config = parseConfig({
      environments: { default: { baseURL: "http://default.example" } },
    });

    expect(resolveEnvironment(config, "default", false).baseURL).toBe(
      "http://default.example",
    );
    expect(resolveEnvironment(config, "default", true).baseURL).toBe(
      "http://default.example",
    );
  });

  it("resolves policy and version only from the environment, undefined when absent", () => {
    const version = () => "1.2.3";
    const config = parseConfig({
      environments: {
        locked: { policy: "read-only", version },
        open: {},
      },
    });

    const locked = resolveEnvironment(config, "locked", true);
    expect(locked.policy).toBe("read-only");
    expect(locked.version).toBe(version);

    const open = resolveEnvironment(config, "open", true);
    expect(open.policy).toBeUndefined();
    expect(open.version).toBeUndefined();
  });

  // Object.prototype's own names match the environment-name pattern, and a
  // bracket read finds them on every plain object. They are not entries the
  // config defined. An own entry with one of those names still is.
  it("rejects an inherited name such as toString or constructor, and still resolves an own name", () => {
    const config = parseConfig({
      baseURL: "http://top.example",
      environments: {
        staging: { baseURL: "http://staging.example" },
        constructor: { baseURL: "http://ctor.example" },
      },
    });

    expect(resolveEnvironment(config, "staging", true).baseURL).toBe("http://staging.example");
    expect(resolveEnvironment(config, "constructor", true).baseURL).toBe("http://ctor.example");

    const bare = parseConfig({
      baseURL: "http://top.example",
      environments: { staging: { baseURL: "http://staging.example" } },
    });
    expect(() => resolveEnvironment(bare, "constructor", true)).toThrow(UnknownEnvironmentError);
    expect(() => resolveEnvironment(bare, "toString", true)).toThrow(UnknownEnvironmentError);
    expect(() => resolveEnvironment(bare, "__proto__", true)).toThrow(UnknownEnvironmentError);
    expect(resolveEnvironment(bare, "staging", true).baseURL).toBe("http://staging.example");
  });
});

// Every name Object.prototype actually owns that the environment-name
// pattern accepts. A generator of arbitrary strings almost never hits
// these, which is how a bracket read of `environments` kept treating
// them as configured entries.
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
      const index = tc.draw(
        gs.integers({ minValue: 0, maxValue: inheritedEnvironmentNames.length - 1 }),
      );
      const inherited = inheritedEnvironmentNames[index];
      if (inherited === undefined) {
        throw new Error("inherited environment name index was out of range");
      }
      const ownName = tc.draw(ownEnvironmentName);
      const ownBase = `http://${ownName}.example`;
      const config = parseConfig({
        baseURL: "http://top.example",
        environments: {
          staging: { baseURL: "http://staging.example" },
          [ownName]: { baseURL: ownBase },
        },
      });

      expect(resolveEnvironment(config, ownName, true).baseURL).toBe(ownBase);
      expect(resolveEnvironment(config, "staging", true).baseURL).toBe("http://staging.example");

      const environments = config.environments ?? {};
      if (Object.hasOwn(environments, inherited)) {
        expect(resolveEnvironment(config, inherited, true).baseURL).toBe(
          `http://${inherited}.example`,
        );
      } else {
        expect(() => resolveEnvironment(config, inherited, true)).toThrow(UnknownEnvironmentError);
      }
    }));
});
