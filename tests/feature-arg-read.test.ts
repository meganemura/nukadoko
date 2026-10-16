import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describeFeatureArgRead } from "../src/feature/feature-arg-read.js";

// Responsibility: the decision in src/feature/feature-arg-read.ts is a pure
// function of an error code, a path, and whether the path with `:<digits>`
// removed exists. These properties pin that a directory, a `:line` suffix,
// a missing file, and every other code stay four different answers, including combinations a single example would not pair.

const DIRECTORY_HINT = "pass a .feature or .md file, or use nuka run for a directory";
const LINE_SUFFIX = /^(.+):(\d+)$/;

const commandGen = gs.sampledFrom(["nuka check"] as const);
const plainPath = gs.fromRegex("features/[a-z]{1,12}\\.(feature|md)");
const linePath = gs.fromRegex("features/[a-z]{1,12}\\.feature:[1-9][0-9]{0,3}");
const anyPath = gs.oneOf(plainPath, linePath);
const otherCode = gs.sampledFrom(["EACCES", "EPERM", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "EIO"]);

const LINE_SENTENCE = "check analyzes the whole file, not one scenario.";

describe("describeFeatureArgRead", () => {
  it("keeps check's :line sentence", () => {
    expect(
      describeFeatureArgRead({
        command: "nuka check",
        relativePath: "features/probe.feature:3",
        code: "ENOENT",
        errorMessage: "ENOENT: no such file or directory",
        lineBaseExists: true,
      }).message,
    ).toBe(
      "nuka check: features/probe.feature:3: :line is not supported; check analyzes the whole file, not one scenario. Run: nuka check features/probe.feature",
    );
  });

  it("names a directory without calling it a missing file", () =>
    hegel.test((tc) => {
      const command = tc.draw(commandGen);
      const relativePath = tc.draw(anyPath);
      const described = describeFeatureArgRead({
        command,
        relativePath,
        code: "EISDIR",
        errorMessage: tc.draw(gs.text()),
        lineBaseExists: tc.draw(gs.booleans()),
      });
      expect(described.kind).toBe("directory");
      expect(described.message).toBe(`${command}: ${relativePath}: ${DIRECTORY_HINT}`);
      expect(described.message).not.toContain("feature file not found");
      expect(described.message.includes("\u2014")).toBe(false);
    }));

  it("keeps every code other than ENOENT and EISDIR as the error's own text", () =>
    hegel.test((tc) => {
      const command = tc.draw(commandGen);
      const errorMessage = tc.draw(gs.text());
      const described = describeFeatureArgRead({
        command,
        relativePath: tc.draw(anyPath),
        code: tc.draw(otherCode),
        errorMessage,
        lineBaseExists: tc.draw(gs.booleans()),
      });
      expect(described).toEqual({ kind: "other", message: `${command}: ${errorMessage}` });
    }));

  it("treats a thrown value with no code as the error's own text", () =>
    hegel.test((tc) => {
      const command = tc.draw(commandGen);
      const errorMessage = tc.draw(gs.text());
      const described = describeFeatureArgRead({
        command,
        relativePath: tc.draw(anyPath),
        code: undefined,
        errorMessage,
        lineBaseExists: tc.draw(gs.booleans()),
      });
      expect(described).toEqual({ kind: "other", message: `${command}: ${errorMessage}` });
    }));

  it("reports ENOENT as a missing file unless a :line suffix names a path that exists", () =>
    hegel.test((tc) => {
      const command = tc.draw(commandGen);
      const relativePath = tc.draw(anyPath);
      const lineBaseExists = tc.draw(gs.booleans());
      const described = describeFeatureArgRead({
        command,
        relativePath,
        code: "ENOENT",
        errorMessage: tc.draw(gs.text()),
        lineBaseExists,
      });
      const lineMatch = LINE_SUFFIX.exec(relativePath);
      if (lineMatch && lineBaseExists) {
        expect(described.kind).toBe("line");
        expect(described.basePath).toBe(lineMatch[1]);
        expect(described.line).toBe(lineMatch[2]);
        expect(described.message).toBe(
          `${command}: ${lineMatch[1]}:${lineMatch[2]}: :line is not supported; ${LINE_SENTENCE} Run: ${command} ${lineMatch[1]}`,
        );
        expect(described.message).not.toContain("feature file not found");
      } else {
        expect(described).toEqual({
          kind: "not-found",
          message: `${command}: feature file not found: ${relativePath}`,
        });
      }
      expect(described.message.includes("\u2014")).toBe(false);
    }));
});
