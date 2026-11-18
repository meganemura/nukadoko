class SlowRowsWereWritten < Nukadoko::Step
  pattern "{n:int} slow rows were written"
  description "The slow item step wrote this many rows, as its execution events say, read before they all arrived"
  args { integer :n, "How many rows" }
  timeout 50
  events writes: { of: ASlowItemIsAdded, count: { kind: "db", op: %w[insert update delete other], committed: true } }
  claims [{ actual: "writes", compare: "equal", expected: "n" }]
end
