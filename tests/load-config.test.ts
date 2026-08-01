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
      expect(result.data.secrets).toEqual({ public: [] });
    }
  });

  it("accepts an explicit secrets.public list", () => {
    const result = configSchema.safeParse({ secrets: { public: ["API_TOKEN"] } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secrets).toEqual({ public: ["API_TOKEN"] });
    }
  });

  it("rejects an unknown key inside secrets", () => {
    const result = configSchema.safeParse({ secrets: { publick: ["oops"] } });
    expect(result.success).toBe(false);
  });
});
