class RowsWereWritten < Nukadoko::Step
  pattern "{n:int} rows were written to {table:string}"
  description "The item step wrote this many rows to the table, as its execution events say"
  args do
    integer :n, "How many rows"
    string :table, "The table the rows went to"
  end
  events writes: { of: AnItemIsAdded, count: { kind: "db", table: { sentence: "table" }, op: %w[insert update delete other], committed: true } }
  claims [{ actual: "writes", compare: "equal", expected: "n" }]
end
