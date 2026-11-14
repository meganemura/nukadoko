import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { reviveStoredForm } from "../src/stored-form/revive.js";

// Responsibility: which side of a two-typed schema reviveStoredForm follows.
// --args and --use (side "input") are what a schema parses; a stored result
// (side "output") is what it produced. The end-to-end cases run through
// tests/do-use.test.ts.

const bigintCodec = z.codec(z.string(), z.bigint(), {
  decode: (text) => BigInt(text),
  encode: (big) => big.toString(),
});
const dateCodec = z.codec(z.iso.datetime(), z.date(), {
  decode: (text) => new Date(text),
  encode: (date) => date.toISOString(),
});
const ISO = "2024-01-01T00:00:00.000Z";

describe("reviveStoredForm on the input side", () => {
  it("leaves a string piped into z.coerce.bigint() a string, and the schema parses it to that bigint", () => {
    hegel.test((tc) => {
      const big = tc.draw(gs.bigIntegers());
      const schema = z.object({ n: z.string().pipe(z.coerce.bigint()) });
      const revived = reviveStoredForm(schema, { n: big.toString() }, "input");
      expect(revived).toEqual({ n: big.toString() });
      expect(schema.parse(revived)).toEqual({ n: big });
    });
  });

  it("revives the decimal string a z.bigint().transform() takes before the transform runs", () => {
    hegel.test((tc) => {
      const big = tc.draw(gs.bigIntegers());
      const schema = z.object({ n: z.bigint().transform((value) => value * 2n) });
      const revived = reviveStoredForm(schema, { n: big.toString() }, "input");
      expect(revived).toEqual({ n: big });
      expect(schema.parse(revived)).toEqual({ n: big * 2n });
    });
  });

  it("leaves a codec's string alone and revives a z.date().transform()'s ISO string", () => {
    const schema = z.object({ coded: bigintCodec, stamped: dateCodec, epoch: z.date().transform((d) => d.getTime()) });
    const revived = reviveStoredForm(schema, { coded: "5", stamped: ISO, epoch: ISO }, "input");
    expect(revived).toEqual({ coded: "5", stamped: ISO, epoch: new Date(ISO) });
    expect(schema.parse(revived)).toEqual({ coded: 5n, stamped: new Date(ISO), epoch: 1704067200000 });
  });

  it("hands a preprocess function the value as given", () => {
    const schema = z.object({ n: z.preprocess((value) => value, z.bigint()) });
    expect(reviveStoredForm(schema, { n: "5" }, "input")).toEqual({ n: "5" });
  });
});

describe("reviveStoredForm on the output side", () => {
  it("revives what a codec or a preprocess produced, and leaves a transform's output alone", () => {
    const schema = z.object({
      coded: bigintCodec,
      stamped: dateCodec,
      pre: z.preprocess((value) => value, z.bigint()),
      doubled: z.bigint().transform((value) => value * 2n),
    });
    expect(reviveStoredForm(schema, { coded: "5", stamped: ISO, pre: "6", doubled: "7" }, "output")).toEqual({
      coded: 5n,
      stamped: new Date(ISO),
      pre: 6n,
      doubled: "7",
    });
  });
});

describe("reviveStoredForm on a union", () => {
  it("leaves a value alone when any option accepts it, whichever option is declared first", () => {
    for (const side of ["input", "output"] as const) {
      expect(reviveStoredForm(z.object({ n: z.union([z.bigint(), z.string()]) }), { n: "5" }, side)).toEqual({ n: "5" });
      expect(reviveStoredForm(z.object({ n: z.union([z.string(), z.bigint()]) }), { n: "5" }, side)).toEqual({ n: "5" });
    }
  });

  it("revives a value no option accepts as given into the first option that accepts it revived", () => {
    expect(reviveStoredForm(z.object({ n: z.union([z.number(), z.bigint()]) }), { n: "5" }, "input")).toEqual({
      n: 5n,
    });
  });
});
