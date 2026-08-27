// Same call shape as a real compat step, but `Given` is imported from
// somewhere other than "nukadoko/compat" -- a same-named function from
// another module must never be misread as a step declaration, so this call
// must extract nothing.
import { Given } from "not-nukadoko/compat";

Given("should never be extracted", function wrongModule() {
  return undefined;
});
