import { setWorldConstructor, World } from "../../nukadoko-compat-shim.js";

// A custom World subclass with its own field (m2b-compat-execution task
// spec: "setWorldConstructor のカスタム World（自前フィールド）") — no
// constructor override needed since it adds no constructor params of its
// own; the base `World`'s single-argument constructor is inherited as-is.
export class CustomWorld extends World {
  visits = 0;
}

setWorldConstructor(CustomWorld);
