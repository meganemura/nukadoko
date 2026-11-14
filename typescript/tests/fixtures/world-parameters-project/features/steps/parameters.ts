import { Then } from "../../nukadoko-compat-shim.js";

const expected = {
  baseUrl: "http://example.test",
  retries: 2,
};

Then("the configured world parameters are present", function (this: { parameters: Record<string, unknown> }) {
  const actual = this.parameters;
  const sameKeys =
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.keys(expected).every((key) => actual[key] === expected[key as keyof typeof expected]);
  if (!sameKeys) {
    throw new Error(`world parameters were ${JSON.stringify(actual)}`);
  }
});
