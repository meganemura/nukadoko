class NameHas < Nukadoko::Step
  description "How many items the name has"
  pattern "the name has {n:int} items"
  args do
    integer :n, "How many"
    string :made, "The name"
  end
  from made: [MakeList, :name]
  claims [{ actual: "made", count: true, compare: "equal", expected: "n" }]
end
