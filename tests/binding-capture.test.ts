import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseCaptureToken } from "../src/binding/capture.js";
import { InvalidCaptureKeyError, UnnamedCaptureError, UnterminatedCaptureError } from "../src/binding/errors.js";
import { stripCaptureNames } from "../src/binding/pattern.js";

describe("parseCaptureToken", () => {
  it("splits key:type on the first colon", () => {
    expect(parseCaptureToken("name:string")).toEqual({ key: "name", type: "string" });
  });

  it("splits on the *first* colon, so a custom type name with a dash survives", () => {
    expect(parseCaptureToken("owner:user-id")).toEqual({ key: "owner", type: "user-id" });
  });

  it("treats {key:} as an anonymous-typed capture (type is the empty string)", () => {
    expect(parseCaptureToken("name:")).toEqual({ key: "name", type: "" });
  });

  it("throws UnnamedCaptureError when there is no colon at all", () => {
    expect(() => parseCaptureToken("string")).toThrow(UnnamedCaptureError);
  });

  it("throws UnnamedCaptureError for the bare anonymous token", () => {
    expect(() => parseCaptureToken("")).toThrow(UnnamedCaptureError);
  });

  it("throws InvalidCaptureKeyError when the key isn't a valid identifier", () => {
    expect(() => parseCaptureToken("1abc:string")).toThrow(InvalidCaptureKeyError);
    expect(() => parseCaptureToken("owner-id:string")).toThrow(InvalidCaptureKeyError);
    expect(() => parseCaptureToken(":string")).toThrow(InvalidCaptureKeyError);
  });

  it("accepts underscores anywhere but the first character being a digit", () => {
    expect(parseCaptureToken("_private:int")).toEqual({ key: "_private", type: "int" });
    expect(parseCaptureToken("a_1:int")).toEqual({ key: "a_1", type: "int" });
  });
});

describe("stripCaptureNames", () => {
  it("only throws its declared pattern errors for arbitrary strings", () =>
    hegel.test((tc) => {
      const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      const text = tc.draw(gs.text());
      const pattern =
        kind === 0
          ? text
          : kind === 1
            ? `{${text.replaceAll(":", "")}}`
            : kind === 2
              ? `{1${text}:string}`
              : `unterminated {${text}`;
      try {
        stripCaptureNames(pattern);
      } catch (error) {
        expect(
          error instanceof UnnamedCaptureError ||
            error instanceof InvalidCaptureKeyError ||
            error instanceof UnterminatedCaptureError,
        ).toBe(true);
      }
    }));

  it("strips a single named capture down to the plain cucumber-expressions form", () => {
    expect(stripCaptureNames("a project {name:string} exists")).toEqual({
      strippedPattern: "a project {string} exists",
      captures: [{ key: "name", type: "string" }],
    });
  });

  it("strips multiple captures in encounter order", () => {
    expect(stripCaptureNames("transfer {amount:int} from {from:string} to {to:string}")).toEqual({
      strippedPattern: "transfer {int} from {string} to {string}",
      captures: [
        { key: "amount", type: "int" },
        { key: "from", type: "string" },
        { key: "to", type: "string" },
      ],
    });
  });

  it("strips {key:} down to the anonymous {} form", () => {
    expect(stripCaptureNames("a {value:} thing")).toEqual({
      strippedPattern: "a {} thing",
      captures: [{ key: "value", type: "" }],
    });
  });

  it("passes through a pattern with no captures unchanged", () => {
    expect(stripCaptureNames("a plain step with no parameters")).toEqual({
      strippedPattern: "a plain step with no parameters",
      captures: [],
    });
  });

  it("does not treat an escaped brace as a capture boundary", () => {
    expect(stripCaptureNames("a literal \\{brace\\} and a {name:string} capture")).toEqual({
      strippedPattern: "a literal \\{brace\\} and a {string} capture",
      captures: [{ key: "name", type: "string" }],
    });
  });

  it("throws UnnamedCaptureError for an unnamed parameter", () => {
    expect(() => stripCaptureNames("a project {string} exists")).toThrow(UnnamedCaptureError);
  });

  it("throws InvalidCaptureKeyError for a malformed key", () => {
    expect(() => stripCaptureNames("a project {1name:string} exists")).toThrow(InvalidCaptureKeyError);
  });

  it("throws UnterminatedCaptureError when a { is never closed", () => {
    expect(() => stripCaptureNames("a project {name:string exists")).toThrow(UnterminatedCaptureError);
  });
});
