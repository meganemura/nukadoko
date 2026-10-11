import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";

// Responsibility: `worldParameters` is a plain object on the config, default
// `{}`. Parsing it is pure, so the cases below are properties of that parse
// rather than one hand-picked object.

const key = gs.text({ minSize: 1, maxSize: 12, alphabet: "abcdefghijklmnopqrstuvwxyz" });
const leaf = gs.oneOf<unknown>(gs.text({ maxSize: 24 }), gs.integers(), gs.booleans(), gs.just(null));
const nested = gs.oneOf<unknown>(
  leaf,
  gs.arrays(leaf, { maxSize: 4 }),
  gs.composite((tc) => Object.fromEntries(tc.draw(gs.arrays(gs.tuples(key, leaf), { maxSize: 4 })))),
);
const worldParameters = gs.composite((tc) =>
  Object.fromEntries(tc.draw(gs.arrays(gs.tuples(key, nested), { maxSize: 6 }))),
);

function parsedWorldParameters(input: unknown): unknown {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return (result.data as { worldParameters?: unknown }).worldParameters;
}

it("keeps a plain worldParameters object and defaults a missing one to {}", () =>
  hegel.test((tc) => {
    const parameters = tc.draw(worldParameters);
    const include = tc.draw(gs.booleans());
    const parsed = parsedWorldParameters(include ? { worldParameters: parameters } : {});
    expect(parsed).toEqual(include ? parameters : {});
  }));
