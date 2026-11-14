class ItemColour < Nukadoko::Step
  description "A claim on the item"
  pattern "the item has a colour"
  args { unknown :made, "The item" }
  from made: [MakeItem, :item]
  claims [{ actual: "made", compare: "has-fields", expected: { from: "made.colour" } }]
end
