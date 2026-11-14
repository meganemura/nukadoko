import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// No `from` declared at all: the plain, common shape of an args validation
// failure through `nuka run`. Proves the failure message stays exactly
// `formatValidationIssues`'s own text, with no from-hint suffix at all,
// when there was never anything for `from` to inject in the first place.
export default defineStep({
  pattern: "a plain args failure on count {count:string}",
  description: "count fails its own schema; this step declares no from at all",
  args: z.object({ count: z.number() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
