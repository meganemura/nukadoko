import { experimental_defineModel, experimental_modelCommand } from "../../nukadoko-shim.js";
import openPage from "../steps/open-page.js";

export default experimental_defineModel(() => ({})).commands({
  "open-page": experimental_modelCommand(openPage)({
    args: () => ({}),
    pre: () => true,
    next: (state) => state,
    post: (_state, _args, result) => result.ok,
  }),
});
