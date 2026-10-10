import { defineModel, modelCommand } from "../../nukadoko-shim.js";
import addTodo from "../steps/add-todo.js";

export default defineModel(() => ({ titles: [] as string[] })).commands({
  "add-todo": modelCommand(addTodo)({
    args: () => ({ title: "milk" }),
    pre: () => true,
    next: (state, args) => ({ titles: [...state.titles, args.title] }),
    post: (_state, args, result) => result.title === args.title,
  }),
});
