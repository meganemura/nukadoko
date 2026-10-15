import { defineModel, modelCommand } from "../../nukadoko-shim.js";
import addTodo from "../steps/add-todo.js";

export default defineModel(() => ({ seen: 0 })).commands({
  "add-todo": modelCommand(addTodo)({
    args: () => ({ title: `todo ${Math.random()}` }),
    pre: () => crypto.randomUUID().length > 0,
    next: (state) => ({ seen: state.seen + (Math.random() > 2 ? 0 : 1) }),
    post: () => true,
  }),
});
