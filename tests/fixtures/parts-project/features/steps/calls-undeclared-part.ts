import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import noOpPart from "./no-op-part.js";

// Never lists no-op-part in its own `parts` — `call()` must refuse it and
// never run it (docs/spec.md "Parts": "`call` refuses a step `parts` does
// not declare").
export default defineStep({
  description: "Calls no-op-part through call() without declaring it as a part",
  args: z.object({}),
  returns: z.object({}),
  async run({ call }) {
    await call(noOpPart, {});
    return {};
  },
});
