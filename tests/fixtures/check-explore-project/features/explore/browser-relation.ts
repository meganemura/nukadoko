import { experimental_defineRelation, experimental_relationEntry } from "../../nukadoko-shim.js";
import openPage from "../steps/open-page.js";

export default experimental_defineRelation({
  name: "open twice",
  source: [experimental_relationEntry(openPage, {})],
  follow: (source) => [experimental_relationEntry(openPage, source[0].args)],
  relate: (sourceResults, followResults) => sourceResults[0].ok === followResults[0].ok,
});
