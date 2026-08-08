import { Given } from "../../nukadoko-compat-shim.js";

// The "before" half of README's "Before / after" (position capture,
// untyped, no schema on args or result) — promotion-comparison-test task
// spec's fixture pair compares this against the "after" typed step in the
// sibling promotion-typed-project fixture's features/steps/create-
// project.ts. Both match the exact same feature line
// (features/promote.feature, byte-identical between the two projects);
// only the step definition behind it differs.
Given("a project {string} exists", async function (name: string) {
  await this.openRequest();
  const res = await this.request.post("/projects", { data: { name } });
  await res.json(); // read and discarded — no schema, no type, unlike the typed side
});
