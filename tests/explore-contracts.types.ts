import { experimental_defineModel, experimental_defineRelation, defineStep, experimental_modelCommand, experimental_relationEntry, z } from "../src/index.js";

const add = defineStep({
  description: "add",
  args: z.object({ title: z.string() }),
  returns: z.object({ id: z.string(), title: z.string(), done: z.boolean() }),
  run() {
    return { id: "1", title: "t", done: false };
  },
});

experimental_defineModel(() => ({ n: 0 })).commands({
  add: experimental_modelCommand(add)({
    args: () => ({ title: "a" }),
    pre: (state) => state.n >= 0,
    next: (state, args) => ({ n: state.n + args.title.length }),
    post: (_state, args, result) => result.title === args.title && result.done === false,
  }),
});

experimental_defineRelation({
  name: "order",
  source: [experimental_relationEntry(add, { title: "A" })],
  follow: (source) => [experimental_relationEntry(add, { title: source[0].args.title })],
  relate: (sourceResults, followResults) => sourceResults[0].id === followResults[0].id,
});

experimental_defineModel(() => ({ n: 0 })).commands({
  add: experimental_modelCommand(add)({
    // @ts-expect-error title is a string on this step, so a number is not args
    args: () => ({ title: 1 }),
    pre: () => true,
    next: (state) => state,
    post: () => true,
  }),
});

experimental_defineRelation({
  name: "bad args",
  source: [
    experimental_relationEntry(
      add,
      // @ts-expect-error title is a string on this step, so a number is not args
      { title: 1 },
    ),
  ],
  follow: (source) => source,
  relate: () => true,
});
