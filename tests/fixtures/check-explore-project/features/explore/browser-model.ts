import { defineModel, modelCommand } from "../../nukadoko-shim.js";
import openPage from "../steps/open-page.js";

export default defineModel(() => ({})).commands({
  "open-page": modelCommand(openPage)({
    args: () => ({}),
    pre: () => true,
    next: (state) => state,
    post: (_state, _args, result) => result.ok,
  }),
});
