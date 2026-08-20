import { defineStep } from "nukadoko";
import { addItem, addItemArgs, addItemReturns } from "./lib/cart.js";
import openCartStep from "./open-cart.js";

export default defineStep({
  pattern: "an item is added",
  description: "Add one item to the cart opened earlier",
  args: addItemArgs,
  returns: addItemReturns,
  from: { cartId: [openCartStep, "id"] },
  async run({ request }, args) {
    return await addItem(request, args.cartId);
  },
});
