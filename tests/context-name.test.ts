import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import * as nukadoko from "../src/index.js";
import {
  ContextOptionsConflictError,
  contextFileName,
  InvalidContextNameError,
  isNamedContextHarnessFile,
  isValidContextName,
  MAX_CONTEXT_NAME_LENGTH,
  snapshotContextOptions,
} from "../src/context/context-name.js";
import { createEvidenceCollector } from "../src/context/evidence.js";
import { ReservedEvidenceNameError } from "../src/context/errors.js";

// Responsibility: the names `pageAs(name)` accepts and the evidence files
// each name produces. A valid name never lands on the default context's
// files or on another name's, and `evidence.attach` cannot take a file a
// named context writes.

const validNames = gs.fromRegex("[a-z0-9][a-z0-9-]{0,20}");
const harnessFiles = gs.sampledFrom(["trace.zip", "final.png", "hook-before-1.zip", "hook-after_step-2-1.zip"]);

describe("context names", () => {
  it("accepts every name of lowercase letters, digits, and hyphens that starts with a letter or a digit", () =>
    hegel.test((tc) => {
      expect(isValidContextName(tc.draw(validNames))).toBe(true);
    }));

  it("refuses a name with any other character, a leading hyphen, or too many characters", () =>
    hegel.test((tc) => {
      const name = tc.draw(validNames);
      const bad = tc.draw(gs.sampledFrom([".", "/", "\\", "A", " ", "_", ":"]));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: name.length }));
      expect(isValidContextName(name.slice(0, at) + bad + name.slice(at))).toBe(false);
      expect(isValidContextName(`-${name}`)).toBe(false);
      expect(isValidContextName("a".repeat(MAX_CONTEXT_NAME_LENGTH + 1))).toBe(false);
      expect(isValidContextName("")).toBe(false);
    }));

  it("gives each name its own file beside the default one, with the extension kept", () =>
    hegel.test((tc) => {
      const base = tc.draw(harnessFiles);
      const first = tc.draw(validNames);
      const second = tc.draw(validNames);
      const file = contextFileName(base, first);
      expect(contextFileName(base, undefined)).toBe(base);
      expect(file).not.toBe(base);
      expect(file.endsWith(base.slice(base.lastIndexOf(".")))).toBe(true);
      expect(file === contextFileName(base, second)).toBe(first === second);
    }));

  it("reserves every named context's trace and screenshot from evidence.attach, in any case", () =>
    hegel.test((tc) => {
      const name = tc.draw(validNames);
      const upper = tc.draw(gs.booleans());
      for (const base of ["trace.zip", "final.png"]) {
        const file = contextFileName(base, name);
        const spelled = upper ? file.toUpperCase() : file;
        expect(isNamedContextHarnessFile(spelled)).toBe(true);
        const collector = createEvidenceCollector(() => "/tmp/nukadoko-unused");
        expect(() => collector.path(spelled)).toThrow(ReservedEvidenceNameError);
      }
    }));

  it("leaves ordinary attachment names free", () => {
    for (const name of ["trace.json", "final.jpg", "trace..zip", "trace.-x.zip", "screenshot.png", "notes.txt"]) {
      expect(isNamedContextHarnessFile(name)).toBe(false);
    }
  });
});

describe("snapshotContextOptions", () => {
  // Nested option values: what `pageAs` compares a later call against.
  const leaf = gs.oneOf<unknown>(gs.integers({ minValue: -5, maxValue: 5 }), gs.booleans(), gs.text({ maxSize: 4 }), gs.just(undefined), gs.just(null));
  const plain = gs.composite((tc): Record<string, unknown> => {
    const keys = tc.draw(gs.arrays(gs.sampledFrom(["viewport", "width", "height", "locale", "javaScriptEnabled"]), { maxSize: 4 }));
    const value: Record<string, unknown> = {};
    for (const key of keys) {
      value[key] = tc.draw(gs.booleans()) ? tc.draw(leaf) : { [key]: tc.draw(leaf), list: [tc.draw(leaf)] };
    }
    return value;
  });

  it("keeps no undefined-valued key, and is unchanged by a later mutation of its input", () =>
    hegel.test((tc) => {
      const options = tc.draw(plain);
      const snapshot = snapshotContextOptions(options);
      const before = JSON.stringify(snapshot);
      expect(Object.values(snapshot).some((value) => value === undefined)).toBe(false);
      for (const value of Object.values(snapshot)) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          expect(Object.values(value).some((inner) => inner === undefined)).toBe(false);
        }
      }
      // JSON drops undefined-valued keys too, so the two must agree.
      expect(before).toBe(JSON.stringify(options));
      for (const value of Object.values(options)) {
        if (typeof value === "object" && value !== null) (value as Record<string, unknown>).mutated = 1;
      }
      options.added = true;
      expect(JSON.stringify(snapshot)).toBe(before);
      expect(snapshotContextOptions(snapshot)).toEqual(snapshot);
    }));

  it("reads no options the same as empty options", () => {
    expect(snapshotContextOptions(undefined)).toEqual({});
    expect(snapshotContextOptions({ viewport: undefined })).toEqual({});
  });
});

describe("the package entry point", () => {
  it("exports both pageAs errors, so a step can tell them apart with instanceof", () => {
    expect(nukadoko.InvalidContextNameError).toBe(InvalidContextNameError);
    expect(nukadoko.ContextOptionsConflictError).toBe(ContextOptionsConflictError);
  });
});
