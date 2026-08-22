import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/errors.js";
import { loadConfig } from "../src/config/load-config.js";
import { configSchema } from "../src/config/schema.js";
import { fixture } from "./helpers/fixtures.js";

describe("loadConfig", () => {
  it("applies defaults when nukadoko.config.ts is absent", async () => {
    const config = await loadConfig(fixture("basic-project"));
    expect(config.featuresDir).toBe("features");
    expect(config.stateDir).toBe(".nukadoko");
  });

  it("honors an explicit config file", async () => {
    const config = await loadConfig(fixture("custom-config-project"));
    expect(config.featuresDir).toBe("bdd");
    expect(config.stateDir).toBe(".state");
  });

  it("throws ConfigError naming the key and the config file path for an unknown key", async () => {
    let caught: unknown;
    try {
      await loadConfig(fixture("invalid-config-project"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const configError = caught as ConfigError;
    expect(configError.message).toContain("typo");
    expect(configError.configPath.endsWith("nukadoko.config.ts")).toBe(true);
    expect(configError.message).toContain(configError.configPath);
  });

  it("names the correctly-cased key when an unknown key matches one case-insensitively", async () => {
    let caught: unknown;
    try {
      await loadConfig(fixture("config-key-suggestion-project"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const configError = caught as ConfigError;
    expect(configError.message).toContain('unknown key(s): baseUrl (did you mean "baseURL"?)');
  });

  it("names the correctly-cased key for a match nested inside an environment entry", async () => {
    let caught: unknown;
    try {
      await loadConfig(fixture("config-key-suggestion-nested-project"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const configError = caught as ConfigError;
    expect(configError.message).toContain('unknown key(s): baseUrl (did you mean "baseURL"?)');
  });

  it("suggests nothing for an unknown key with no case-insensitive match", async () => {
    let caught: unknown;
    try {
      await loadConfig(fixture("invalid-config-project"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const configError = caught as ConfigError;
    // "typo" is not a case-insensitive match for any real key — a guessed
    // suggestion would be worse than none (CLAUDE.md: "a check that
    // guesses is worse than no check"), so this asserts the message names
    // only the key, never a "(did you mean ...)" aside.
    expect(configError.message).toContain("unknown key(s): typo");
    expect(configError.message).not.toContain("did you mean");
  });
});

describe("configSchema", () => {
  it("rejects an invalid value type for a known key", () => {
    const result = configSchema.safeParse({ featuresDir: 123 });
    expect(result.success).toBe(false);
  });

  it("accepts an empty object and fills in defaults", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.featuresDir).toBe("features");
      expect(result.data.stateDir).toBe(".nukadoko");
      expect(result.data.secrets).toEqual({ public: [], redact: [] });
    }
  });

  it("accepts an explicit secrets.public list", () => {
    const result = configSchema.safeParse({ secrets: { public: ["API_TOKEN"] } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secrets).toEqual({ public: ["API_TOKEN"], redact: [] });
    }
  });

  it("rejects an unknown key inside secrets", () => {
    const result = configSchema.safeParse({ secrets: { publick: ["oops"] } });
    expect(result.success).toBe(false);
  });

  it("accepts an explicit secrets.redact list", () => {
    const result = configSchema.safeParse({ secrets: { redact: ["API_SECRET_KEY"] } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secrets).toEqual({ public: [], redact: ["API_SECRET_KEY"] });
    }
  });

  it("rejects the same key named in both secrets.public and secrets.redact", () => {
    const result = configSchema.safeParse({
      secrets: { public: ["SHARED_KEY"], redact: ["SHARED_KEY"] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("SHARED_KEY");
      expect(message).toContain("secrets.public");
      expect(message).toContain("secrets.redact");
    }
  });

  it("accepts distinct keys in secrets.public and secrets.redact", () => {
    const result = configSchema.safeParse({
      secrets: { public: ["PUBLIC_ONE"], redact: ["REDACT_ONE"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secrets).toEqual({ public: ["PUBLIC_ONE"], redact: ["REDACT_ONE"] });
    }
  });
});

describe("configSchema: environments", () => {
  it("accepts baseURL, envFiles, policy: read-only, and a version function", () => {
    const version = () => "1.0.0";
    const result = configSchema.safeParse({
      environments: {
        staging: {
          baseURL: "http://staging.example",
          envFiles: [".env.staging"],
          policy: "read-only",
          version,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.environments?.staging).toEqual({
        baseURL: "http://staging.example",
        envFiles: [".env.staging"],
        policy: "read-only",
        version,
      });
    }
  });

  it("accepts an environment with no fields at all", () => {
    const result = configSchema.safeParse({ environments: { staging: {} } });
    expect(result.success).toBe(true);
  });

  it("rejects an environment name outside [a-z0-9_-]+", () => {
    const result = configSchema.safeParse({ environments: { "Bad Name": {} } });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside an environment entry", () => {
    const result = configSchema.safeParse({ environments: { staging: { typo: true } } });
    expect(result.success).toBe(false);
  });

  it("rejects a policy value other than the literal read-only", () => {
    const result = configSchema.safeParse({
      environments: { staging: { policy: "readonly" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-function version", () => {
    const result = configSchema.safeParse({
      environments: { staging: { version: "1.0.0" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("configSchema: parameterTypes", () => {
  it("defaults to an empty list when omitted", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parameterTypes).toEqual([]);
    }
  });

  it("accepts a well-formed entry with a RegExp and a transformer", () => {
    const transformer = (s: string) => s === " not";
    const result = configSchema.safeParse({
      parameterTypes: [{ name: "negation", regexp: /( not)?/, transformer }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parameterTypes).toEqual([
        { name: "negation", regexp: /( not)?/, transformer },
      ]);
    }
  });

  it("accepts a string regexp, and an entry with no transformer at all", () => {
    const result = configSchema.safeParse({
      parameterTypes: [{ name: "loud", regexp: "[A-Z]+" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parameterTypes).toEqual([{ name: "loud", regexp: "[A-Z]+" }]);
    }
  });

  it("rejects a name outside [a-zA-Z0-9_-]+", () => {
    const result = configSchema.safeParse({
      parameterTypes: [{ name: "not valid!", regexp: /x/ }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a regexp that is neither a RegExp nor a string", () => {
    const result = configSchema.safeParse({
      parameterTypes: [{ name: "oops", regexp: 42 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-function transformer", () => {
    const result = configSchema.safeParse({
      parameterTypes: [{ name: "oops", regexp: /x/, transformer: "not a function" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside an entry", () => {
    const result = configSchema.safeParse({
      parameterTypes: [{ name: "oops", regexp: /x/, typo: true }],
    });
    expect(result.success).toBe(false);
  });
});

describe("configSchema: browser", () => {
  it("leaves browser undefined when omitted", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.browser).toBeUndefined();
    }
  });

  it("accepts a Playwright LaunchOptions object, unmodified", () => {
    const result = configSchema.safeParse({ browser: { headless: false, slowMo: 50 } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.browser).toEqual({ headless: false, slowMo: 50 });
    }
  });

  it("rejects a non-object value (zod checks only 'is this an object')", () => {
    expect(configSchema.safeParse({ browser: "headless" }).success).toBe(false);
    expect(configSchema.safeParse({ browser: 42 }).success).toBe(false);
    expect(configSchema.safeParse({ browser: true }).success).toBe(false);
    expect(configSchema.safeParse({ browser: null }).success).toBe(false);
  });
});

// Responsibility: schema-level tests — that `config.browserType` is
// restricted to a closed set of values is caught by zod's schema, and
// that's enough. Whether firefox/
// webkit are actually *installed* is not this schema's concern (that can
// only be learned by launching, not by reading config) and is left to
// Playwright's own error at launch time; see src/context/browser-evidence.ts.
describe("configSchema: browserType", () => {
  it('defaults to "chromium" when omitted', () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.browserType).toBe("chromium");
    }
  });

  it('accepts "firefox" and "webkit" explicitly', () => {
    for (const browserType of ["firefox", "webkit"] as const) {
      const result = configSchema.safeParse({ browserType });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.browserType).toBe(browserType);
      }
    }
  });

  it("rejects a value outside chromium/firefox/webkit", () => {
    const result = configSchema.safeParse({ browserType: "safari" });
    expect(result.success).toBe(false);
  });
});

describe("configSchema: browserContext", () => {
  it("leaves browserContext undefined when omitted", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.browserContext).toBeUndefined();
    }
  });

  it("accepts a BrowserContextOptions object, unmodified", () => {
    const result = configSchema.safeParse({
      browserContext: { ignoreHTTPSErrors: true, viewport: { width: 800, height: 600 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.browserContext).toEqual({
        ignoreHTTPSErrors: true,
        viewport: { width: 800, height: 600 },
      });
    }
  });

  it("rejects a non-object value", () => {
    expect(configSchema.safeParse({ browserContext: "oops" }).success).toBe(false);
    expect(configSchema.safeParse({ browserContext: null }).success).toBe(false);
  });

  it("rejects browserContext.baseURL, with a message stating config.baseURL is the only source", () => {
    const result = configSchema.safeParse({
      browserContext: { baseURL: "http://example.invalid" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("browserContext.baseURL");
      expect(message).toContain("config.baseURL is the only source");
    }
  });

  it("rejects browserContext.storageState, with a message stating the session mechanism owns it", () => {
    const result = configSchema.safeParse({
      browserContext: { storageState: { cookies: [], origins: [] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("browserContext.storageState");
      expect(message).toContain("session mechanism");
    }
  });
});

describe("configSchema: requestContext", () => {
  it("leaves requestContext undefined when omitted", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestContext).toBeUndefined();
    }
  });

  it("accepts an APIRequest.newContext options object, unmodified", () => {
    const result = configSchema.safeParse({
      requestContext: { ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-test": "1" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestContext).toEqual({
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { "x-test": "1" },
      });
    }
  });

  it("rejects a non-object value", () => {
    expect(configSchema.safeParse({ requestContext: "oops" }).success).toBe(false);
    expect(configSchema.safeParse({ requestContext: null }).success).toBe(false);
  });

  it("rejects requestContext.baseURL, with a message stating config.baseURL is the only source", () => {
    const result = configSchema.safeParse({
      requestContext: { baseURL: "http://example.invalid" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("requestContext.baseURL");
      expect(message).toContain("config.baseURL is the only source");
    }
  });

  it("rejects requestContext.storageState, with a message stating the session mechanism owns it", () => {
    const result = configSchema.safeParse({
      requestContext: { storageState: { cookies: [], origins: [] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("requestContext.storageState");
      expect(message).toContain("session mechanism");
    }
  });
});

describe("configSchema: allure", () => {
  it("leaves allure undefined when omitted (the <stateDir>/allure-results default is applied by the caller, not this schema)", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allure).toBeUndefined();
    }
  });

  it("accepts an explicit, root-relative resultsDir", () => {
    const result = configSchema.safeParse({ allure: { resultsDir: "reports/allure-results" } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allure).toEqual({ resultsDir: "reports/allure-results" });
    }
  });

  it("accepts allure with no fields at all", () => {
    const result = configSchema.safeParse({ allure: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allure).toEqual({});
    }
  });

  it("rejects an unknown key inside allure (there is no `enabled`)", () => {
    const result = configSchema.safeParse({ allure: { enabled: false } });
    expect(result.success).toBe(false);
  });
});

describe("configSchema: messages", () => {
  it("leaves messages undefined when omitted (the <stateDir>/messages.ndjson default is applied by the caller, not this schema)", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toBeUndefined();
    }
  });

  it("accepts an explicit, root-relative output path", () => {
    const result = configSchema.safeParse({ messages: { output: "reports/messages.ndjson" } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toEqual({ output: "reports/messages.ndjson" });
    }
  });

  it("accepts messages with no fields at all", () => {
    const result = configSchema.safeParse({ messages: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toEqual({});
    }
  });

  it("rejects an unknown key inside messages (there is no `enabled`)", () => {
    const result = configSchema.safeParse({ messages: { enabled: false } });
    expect(result.success).toBe(false);
  });
});

// Responsibility: schema-level unit tests for P5's own `fixtures`/
// `fixtureTimeout` fields (src/config/schema.ts) — the shape checks
// (function or [function, options] tuple, `auto: true` refused with its
// own dedicated message, `scope`/`timeout` validated) that never reach a
// real `nuka check`/`nuka run` invocation in the fixture-project-level
// tests (tests/check-fixture-definitions.test.ts). A fixture's own
// dependency *names* (unknown name, cycle, scope violation) are
// deliberately not this schema's job — those are src/step/validate-
// fixtures.ts's, exercised there and in tests/fixture-graph.test.ts.
describe("configSchema: fixtures", () => {
  it("defaults fixtures to {} and fixtureTimeout to 60000", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fixtures).toEqual({});
      expect(result.data.fixtureTimeout).toBe(60_000);
    }
  });

  it("accepts a bare function fixture", () => {
    const result = configSchema.safeParse({
      fixtures: { tenant: async (_deps: unknown, use: (v: unknown) => Promise<unknown>) => use(1) },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a [function, options] tuple fixture", () => {
    const result = configSchema.safeParse({
      fixtures: {
        seededDb: [
          async (_deps: unknown, use: (v: unknown) => Promise<unknown>) => use(1),
          { scope: "process", timeout: 5_000 },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-function, non-tuple value", () => {
    const result = configSchema.safeParse({ fixtures: { tenant: "not a function" } });
    expect(result.success).toBe(false);
  });

  it("rejects a fixture name that isn't a valid identifier", () => {
    const result = configSchema.safeParse({
      fixtures: { "not-an-identifier": async () => {} },
    });
    expect(result.success).toBe(false);
  });

  it("rejects auto: true, naming why in the message", () => {
    const result = configSchema.safeParse({
      fixtures: { seededDb: [async () => {}, { auto: true }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("auto");
      expect(message).toMatch(/names everything that ran|Playwright fixture/);
    }
  });

  it('rejects scope: "worker" (does not exist yet)', () => {
    const result = configSchema.safeParse({
      fixtures: { seededDb: [async () => {}, { scope: "worker" }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("worker");
    }
  });

  // `"run"` was the pre-rename spelling of what
  // is now `"process"` — since this package is still unpublished, there is
  // no backward-compat door left open for it, on purpose (two names for the
  // same scope is exactly the ambiguity the rename exists to remove).
  it('rejects scope: "run" (renamed to "process")', () => {
    const result = configSchema.safeParse({
      fixtures: { seededDb: [async () => {}, { scope: "run" }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("process");
    }
  });

  it("rejects a non-numeric timeout", () => {
    const result = configSchema.safeParse({
      fixtures: { seededDb: [async () => {}, { timeout: "soon" }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown option key", () => {
    const result = configSchema.safeParse({
      fixtures: { seededDb: [async () => {}, { retries: 3 }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a fixtureTimeout of zero or a negative number", () => {
    expect(configSchema.safeParse({ fixtureTimeout: 0 }).success).toBe(false);
    expect(configSchema.safeParse({ fixtureTimeout: -1 }).success).toBe(false);
  });
});
