import { Given, When, Then } from "nukadoko/compat";

// One string pattern and one regexp literal -- the two compat pattern
// shapes tests/extraction/step-extraction.test.ts's "compat" case covers.
// `When`/`Then` are imported and used too, so the extractor's keyword
// coverage isn't only proven for `Given`.
Given("a {int} widgets", function widgetsGiven(count: number) {
  return count;
});

Given(/^a (\d+) widgets$/, function widgetsRegex(count: string) {
  return count;
});

When("the widgets are counted", function widgetsCounted() {
  return undefined;
});

Then("there are {int} widgets left", function widgetsLeft(count: number) {
  return count;
});
