import { experimental_defineModel, experimental_modelCommand } from "../../nukadoko-shim.js";
import addTodo from "../steps/add-todo.js";

export default experimental_defineModel(() => ({ titles: [] as string[] })).commands({
  "add-todo": experimental_modelCommand(addTodo)({
    args: () => ({ title: "milk" }),
    pre: () => true,
    next: (state, args) => ({ titles: [...state.titles, args.title] }),
    post: (_state, args, result) => result.title === args.title,
  }),
});
