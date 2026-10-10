import { defineModel, defineRelation, defineStep, modelCommand, relationEntry, z } from "../src/index.js";

const add = defineStep({
  description: "add",
  args: z.object({ title: z.string() }),
  returns: z.object({ id: z.string(), title: z.string(), done: z.boolean() }),
  run() {
    return { id: "1", title: "t", done: false };
  },
});

defineModel(() => ({ n: 0 })).commands({
  add: modelCommand(add)({
    args: () => ({ title: "a" }),
    pre: (state) => state.n >= 0,
    next: (state, args) => ({ n: state.n + args.title.length }),
    post: (_state, args, result) => result.title === args.title && result.done === false,
  }),
});

defineRelation({
  name: "order",
  source: [relationEntry(add, { title: "A" })],
  follow: (source) => [relationEntry(add, { title: source[0].args.title })],
  relate: (sourceResults, followResults) => sourceResults[0].id === followResults[0].id,
});

defineModel(() => ({ n: 0 })).commands({
  add: modelCommand(add)({
    // @ts-expect-error title is a string on this step, so a number is not args
    args: () => ({ title: 1 }),
    pre: () => true,
    next: (state) => state,
    post: () => true,
  }),
});

defineRelation({
  name: "bad args",
  source: [
    relationEntry(
      add,
      // @ts-expect-error title is a string on this step, so a number is not args
      { title: 1 },
    ),
  ],
  follow: (source) => source,
  relate: () => true,
});
