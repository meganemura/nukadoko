import { expect, test } from "playwright/test";
import { addItem, addItemReturns, openCart } from "../features/steps/lib/cart.js";

// Outside featuresDir on purpose (docs/spec.md "The second door": a
// `.spec.ts` file under featuresDir would get imported by nukadoko's own
// discovery walk, and Playwright's `test()` refuses to be called outside
// its own runner). Imports the exact same helpers and schema the sibling
// typed steps (../features/steps/open-cart.ts, add-item.ts) declare their
// contract with -- nothing here imports nukadoko, so this suite's own
// dependency surface is exactly Playwright and the shared unit, unchanged
// from before nukadoko ever entered the picture.
test("an item lands in a new cart", async ({ request }) => {
  const cart = await openCart(request);
  const result = addItemReturns.parse(await addItem(request, cart.id));
  expect(result.count).toBe(1);
});
