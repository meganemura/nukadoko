class TheAddWroteItems < Nukadoko::Step
  pattern "the add wrote {n:int} item"
  description "The add wrote this many rows to the items table, as its execution events say"
  args { integer :n, "How many rows" }
  events items: { of: AnItemIsAdded, count: { kind: "db", table: "items", committed: true } }
  claims [{ actual: "items", compare: "equal", expected: "n" }]
end
