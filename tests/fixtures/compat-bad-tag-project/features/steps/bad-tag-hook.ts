import { Before } from "../../nukadoko-compat-shim.js";

// v1 supports only a single `@tag` or `not @tag` (src/compat/tag-
// expression.ts) — "and"/"or"/parentheses are Cucumber tag expression
// grammar this slice deliberately does not implement (m2b-compat-execution
// task spec, item 5: "それ以外の式はセットアップエラーで「未対応」を明言").
Before({ tags: "@a and @b" }, function () {
  // Never reached: this is a setup-time validation failure.
});
