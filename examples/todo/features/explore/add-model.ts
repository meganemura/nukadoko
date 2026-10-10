import { defineModel, modelCommand } from "nukadoko";
import addTodo from "../steps/add-todo.js";

// A request-only model. `nuka check` reads the command key and the step.
// It does not call the initial state or the command functions.
export default defineModel(() => ({ titles: [] as string[] })).commands({
  "add-todo": modelCommand(addTodo)({
    args: () => ({ title: "milk" }),
    pre: () => true,
    next: (state, args) => ({ titles: [...state.titles, args.title] }),
    post: (_state, args, result) => result.title === args.title,
  }),
});
