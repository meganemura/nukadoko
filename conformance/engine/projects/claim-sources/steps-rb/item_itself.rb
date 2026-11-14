class ItemItself < Nukadoko::Step
  description "A claim on the item"
  pattern "the item is itself"
  args { unknown :made, "The item" }
  from made: [MakeItem, :item]
  claims [{ actual: "made", compare: "equal", expected: { from: "made" } }]
end
