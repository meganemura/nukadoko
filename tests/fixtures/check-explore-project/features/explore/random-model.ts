import { defineModel, modelCommand } from "../../nukadoko-shim.js";
import addTodo from "../steps/add-todo.js";

export default defineModel(() => ({ seen: 0 })).commands({
  "add-todo": modelCommand(addTodo)({
    args: () => ({ title: `todo ${Math.random()}` }),
    pre: () => true,
    next: (state) => ({ seen: state.seen + (crypto.randomUUID().length > 0 ? 1 : 0) }),
    post: () => true,
  }),
});
