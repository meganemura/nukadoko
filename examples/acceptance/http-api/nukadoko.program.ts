import { defineProgram } from "nukadoko";

// One API server for each environment of the run, on a port of its own.
// It keeps its items in memory, so a scenario sees the items earlier
// scenarios created, and each one claims only on what it created itself
// (S8). ITEM_COUNT switches GET /items/count on; the two environments are
// its two sides, and conditions says which side each one is, so the
// scenario tagged @with:item_count runs in count-off as a control.
// ITEM_COUNT is the condition itself, so the switch the server reads and
// the side a cell counts for cannot disagree.
export default defineProgram({
  serve: { command: "node src/server.ts", ready: "/items" },
  env: { PORT: "{port}", ITEM_COUNT: "{condition.item_count}" },
  environments: {
    "count-off": { conditions: { item_count: false } },
    "count-on": { conditions: { item_count: true } },
  },
});
