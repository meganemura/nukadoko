import { defineModel, modelCommand } from "nukadoko";
import addTodo from "../steps/add-todo.js";
import completeTodo from "../steps/complete-todo.js";

// A request-only model. `nuka check` reads the command keys and the steps.
// `nuka explore features/explore/add-model.ts` runs it against the app.
const TITLES = ["milk", "eggs", "bread"];

export default defineModel(() => ({ open: [] as string[] })).commands({
  "add-todo": modelCommand(addTodo)({
    args: (_state, draw) => ({ title: draw.pick(TITLES) }),
    pre: () => true,
    next: (state, args) => ({ open: [...state.open, args.title] }),
    post: (_state, args, result) => result.title === args.title && !result.done,
  }),
  "complete-todo": modelCommand(completeTodo)({
    args: (state, draw) => ({ title: draw.pick(state.open) }),
    pre: (state) => state.open.length > 0,
    next: (state, args) => {
      const open = [...state.open];
      open.splice(open.indexOf(args.title), 1);
      return { open };
    },
    post: (_state, args, result) => result.title === args.title && result.done,
  }),
});
