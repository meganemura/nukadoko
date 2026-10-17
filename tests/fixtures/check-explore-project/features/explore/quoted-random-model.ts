import { experimental_defineModel, experimental_modelCommand } from "../../nukadoko-shim.js";
import addTodo from "../steps/add-todo.js";

// Math.random() named in a comment, a string, and a regex is not a call.
export default experimental_defineModel(() => ({ seen: 0 })).commands({
  "add-todo": experimental_modelCommand(addTodo)({
    args: (_state, draw) => ({ title: draw.pick(["Math.random()", "crypto.randomUUID()"]) }),
    pre: () => /Math\.random\(\)/.source.length > 0,
    next: (state) => ({ seen: state.seen + 1 }), // Math.random() would break replay
    post: () => true,
  }),
});
