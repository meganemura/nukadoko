class ShownTotalPlus < Nukadoko::Step
  description "The list against a total observe reads"
  pattern "the list is as long as the shown total plus one"
  args do
    strings :made, "The items"
  end
  from made: [MakeList, :items]
  claims [{ actual: "made", count: true, compare: "equal", expected: { observe: "shown" } }]

  def observe(args:) = { shown: 4 }
end
