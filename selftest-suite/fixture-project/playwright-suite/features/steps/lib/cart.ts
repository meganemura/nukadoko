import type { APIRequestContext } from "playwright";
import { z } from "zod";

// The shared unit docs/spec.md "The second door: a Playwright Test suite"
// describes: plain functions over Playwright's own APIRequestContext, plus
// the zod schemas both e2e/cart.spec.ts and the sibling typed steps
// (open-cart.ts, add-item.ts) declare their contract with. Nothing here
// imports nukadoko or playwright/test, so the dependency arrow stays one
// way: the spec and the steps both import this file, never the reverse.
//
// Lives under features/steps/lib/ on purpose, inside featuresDir: nukadoko's
// own discovery walk imports every file it finds there, but only ever acts
// on a default export branded as a Step (src/discover/discover-steps.ts) --
// a shared helper with no default export at all is imported and silently
// skipped, the same as any other support-only file.

export const openCartArgs = z.object({});
export const openCartReturns = z.object({ id: z.string() });

export async function openCart(request: APIRequestContext) {
  const response = await request.post("/carts");
  return openCartReturns.parse(await response.json());
}

export const addItemArgs = z.object({ cartId: z.string().describe("The cart to add to") });
export const addItemReturns = z.object({
  cartId: z.string(),
  count: z.number().describe("Items in the cart after the add"),
});

export async function addItem(request: APIRequestContext, cartId: string) {
  const response = await request.post(`/items/${cartId}`);
  return addItemReturns.parse(await response.json());
}
