import { test } from "playwright/test";

// A Playwright spec placed inside `featuresDir` (docs/spec.md "The second
// door", first of the two named mistakes). Discovery imports every .ts
// file under featuresDir the same way it imports a step file, and
// Playwright's own test() refuses to be called outside its own runner, so
// this import throws. This file exists only to give `nuka check` that
// failure to catch.
test("opens the cart", async ({ page }) => {
  await page.goto("https://example.com/cart");
});
