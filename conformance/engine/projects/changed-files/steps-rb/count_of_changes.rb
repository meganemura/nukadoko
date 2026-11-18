class CountOfChanges < Nukadoko::Step
  pattern "{count:int} files were written"
  description "How many paths the program added or changed"
  args { integer :count, "How many" }
  files written: { of: WriteNotes, change: %w[added changed] }
  claims [{ actual: "written", count: true, compare: "equal", expected: "count" }]
end
