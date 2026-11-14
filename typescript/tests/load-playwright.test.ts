import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { isPlaywrightMissing, PlaywrightMissingError } from "../src/context/load-playwright.js";

// Responsibility: the install hint appears only when the `playwright`
// package itself is missing. A missing `playwright-core`, or any other
// package an installed Playwright fails to load, keeps its own error, since
// installing `playwright` again would not fix it.

function notFound(specifier: string): Error {
  const error = new Error(`Cannot find package '${specifier}' imported from /project/node_modules/nukadoko/dist/x.js`);
  (error as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
  return error;
}

const packageNames = gs.fromRegex("[a-z@][a-z0-9./_-]{0,30}", { fullmatch: true });

describe("isPlaywrightMissing", () => {
  it("is true for playwright itself and false for every other package name", () =>
    hegel.test((tc) => {
      const name = tc.draw(packageNames);
      expect(isPlaywrightMissing(notFound(name))).toBe(name === "playwright");
    }));

  it("is false for any error code other than ERR_MODULE_NOT_FOUND", () =>
    hegel.test((tc) => {
      const code = tc.draw(gs.sampledFrom(["ERR_REQUIRE_ESM", "ERR_UNKNOWN_FILE_EXTENSION", "ENOENT", "EACCES"]));
      const error = notFound("playwright");
      (error as NodeJS.ErrnoException).code = code;
      expect(isPlaywrightMissing(error)).toBe(false);
    }));

  it("is false for playwright-core", () => {
    expect(isPlaywrightMissing(notFound("playwright-core"))).toBe(false);
  });
});

describe("PlaywrightMissingError", () => {
  it("is one line that names what needed playwright", () =>
    hegel.test((tc) => {
      const neededBy = tc.draw(gs.text({ maxSize: 40 }).filter((text) => !/[\r\n]/.test(text)));
      const message = new PlaywrightMissingError(neededBy).message;
      expect(message.startsWith(`${neededBy} needs "playwright"`)).toBe(true);
      expect(message).not.toMatch(/[\r\n]/);
    }));
});
