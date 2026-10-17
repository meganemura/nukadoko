import { experimental_defineRelation, experimental_relationEntry } from "../nukadoko-shim.js";
import addNumber from "./steps/add-number.js";

export default experimental_defineRelation({
  name: "adding in reverse order reaches the same total",
  source: (draw, length) =>
    Array.from({ length: draw.int(1, length) }, () => experimental_relationEntry(addNumber, { n: draw.int(0, 9) })),
  follow: (source) => [...source].reverse(),
  relate: (source, follow) => source.at(-1)!.total === follow.at(-1)!.total,
});
