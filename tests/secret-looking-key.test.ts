import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { looksLikeSecretKey } from "../src/check/config-check.js";

// Responsibility: the name heuristic behind `tracked-secret-looking-key`.
// The affix alphabet leaves out S, T, C, P and K, so no generated affix can
// spell SECRET, PASSWORD, TOKEN or CREDENTIAL, or add a KEY of its own.
const affix = gs.fromRegex("[ABDEFGHJLMNOQRUVWXYZ0-9]{0,6}", { fullmatch: true });
const token = gs.fromRegex("[ABDEFGHJLMNOQRUVWXYZ0-9]{1,6}", { fullmatch: true });

describe("looksLikeSecretKey: KEY is a whole underscore-delimited token", () => {
  it("never matches a name whose only KEY is inside a longer word", () =>
    hegel.test((tc) => {
      const before = tc.draw(affix);
      const after = tc.draw(affix);
      tc.assume(before !== "" || after !== "");
      expect(looksLikeSecretKey(`${before}KEY${after}`)).toBe(false);
      expect(looksLikeSecretKey(`X_${before}KEY${after}`)).toBe(false);
      expect(looksLikeSecretKey(`${before}KEY${after}_X`)).toBe(false);
    }));

  it("matches a name where KEY stands as its own token, in any case", () =>
    hegel.test((tc) => {
      const before = tc.draw(gs.arrays(token, { minSize: 0, maxSize: 3 }));
      const after = tc.draw(gs.arrays(token, { minSize: 0, maxSize: 3 }));
      const name = [...before, "KEY", ...after].join("_");
      expect(looksLikeSecretKey(name)).toBe(true);
      expect(looksLikeSecretKey(name.toLowerCase())).toBe(true);
    }));

  it("keeps matching the four keyword substrings inside a word", () => {
    for (const name of ["APP_SECRETS", "DBPASSWORD", "XTOKENX", "MY_CREDENTIALS"]) {
      expect(looksLikeSecretKey(name)).toBe(true);
    }
  });

  it("gives the names a tracked env file commonly holds their literal verdict", () => {
    const verdicts = Object.fromEntries(
      [
        "SEARCH_KEYWORD",
        "DEFAULT_KEYBOARD_LAYOUT",
        "MAX_KEYS_PER_PAGE",
        "NEXT_KEYWORD",
        "APIKEY",
        "STRIPEKEY",
        "PUBLIC_KEY_URL",
        "API_KEY",
        "KEY",
        "KEY_ID",
      ].map((name) => [name, looksLikeSecretKey(name)]),
    );
    expect(verdicts).toEqual({
      SEARCH_KEYWORD: false,
      DEFAULT_KEYBOARD_LAYOUT: false,
      MAX_KEYS_PER_PAGE: false,
      NEXT_KEYWORD: false,
      APIKEY: false,
      STRIPEKEY: false,
      PUBLIC_KEY_URL: true,
      API_KEY: true,
      KEY: true,
      KEY_ID: true,
    });
  });
});
