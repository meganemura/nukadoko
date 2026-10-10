import { defineRelation, relationEntry } from "../../nukadoko-shim.js";
import openPage from "../steps/open-page.js";

export default defineRelation({
  name: "open twice",
  source: [relationEntry(openPage, {})],
  follow: (source) => [relationEntry(openPage, source[0].args)],
  relate: (sourceResults, followResults) => sourceResults[0].ok === followResults[0].ok,
});
