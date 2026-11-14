import { When } from "../../nukadoko-compat-shim.js";

// The measured door: opens the
// same shared ctx's request context a typed step's `request` fixture also
// reaches, so the cookie this GET picks up is visible to a *typed* step
// later in the same pickle (proving ctx sharing across kinds).
When("a legacy cookie is set", async function () {
  await this.openRequest();
  await this.request.get("/set-cookie");
});
