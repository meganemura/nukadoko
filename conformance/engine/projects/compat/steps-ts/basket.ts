import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "nukadoko/compat";

Before(function () {
  this.tagged = false;
});

Before("@tagged", function () {
  this.tagged = true;
});

After(function () {
  this.closed = true;
});

Given("an empty basket", function () {
  this.basket = [];
});

When("I add {int} apples", function (count: number) {
  for (let i = 0; i < count; i += 1) this.basket.push("apple");
});

When("I add these fruits:", function (table) {
  for (const row of table.hashes()) {
    for (let i = 0; i < Number(row.count); i += 1) this.basket.push(row.name);
  }
});

Then(/^the basket holds (\d+) fruits$/, function (count: string) {
  assert.equal(this.basket.length, Number(count));
});

Then("the hook saw the tag", function () {
  assert.equal(this.tagged, true);
});

When("I weigh the basket", function () {
  return "pending";
});
