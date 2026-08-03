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

  it("rejects a non-object value (t6-config-browser task spec: zod checks only 'is this an object')", () => {
    expect(configSchema.safeParse({ browser: "headless" }).success).toBe(false);
    expect(configSchema.safeParse({ browser: 42 }).success).toBe(false);
    expect(configSchema.safeParse({ browser: true }).success).toBe(false);
    expect(configSchema.safeParse({ browser: null }).success).toBe(false);
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
