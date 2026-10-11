import { setWorldConstructor, World, type IWorldOptions } from "../../nukadoko-compat-shim.js";

// The first construction throws and the second does not, so a run of two
// scenarios can show that the failure stays on the first scenario.
let constructions = 0;

class BoomWorld extends World {
  constructor(options: IWorldOptions) {
    super(options);
    constructions += 1;
    if (constructions === 1) {
      throw new Error("world constructor boom");
    }
  }
}

setWorldConstructor(BoomWorld);
