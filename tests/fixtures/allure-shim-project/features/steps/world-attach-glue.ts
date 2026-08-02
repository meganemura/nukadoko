import { Given } from "../../nukadoko-compat-shim.js";

// Proves item 4: the World channel (`this.attach`/`log`/`link`, held-but-
// unread since m2b-compat-execution) now routes to the same declared
// collector the allure facade itself writes into.
Given("a compat step uses the World declare channel", function () {
  this.attach("hello from world attach", "text/plain");
  this.log("a logged world line");
  this.link("https://example.com/world-link", "world link");
});
