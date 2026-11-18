class ThePeekWroteRows < Nukadoko::Step
  pattern "the peek wrote {n:int} rows"
  description "The peek wrote this many rows to tables that hold state, as its execution events say"
  args { integer :n, "How many rows" }
  events writes: { of: TheItemsArePeeked, count: { kind: "db", committed: true } }
  claims [{ actual: "writes", compare: "equal", expected: "n" }]
end
