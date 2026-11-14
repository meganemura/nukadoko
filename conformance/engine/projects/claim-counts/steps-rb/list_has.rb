class ListHas < Nukadoko::Step
  description "How many items the list has"
  pattern "the list has {n:int} items"
  args do
    integer :n, "How many"
    strings :made, "The items"
  end
  from made: [MakeList, :items]
  claims [{ actual: "made", count: true, compare: "equal", expected: "n" }]
end
