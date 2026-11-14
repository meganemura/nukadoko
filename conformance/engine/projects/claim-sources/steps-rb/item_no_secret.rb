class ItemNoSecret < Nukadoko::Step
  description "A claim on the item"
  pattern "the item has no secret"
  args { unknown :made, "The item" }
  from made: [MakeItem, :item]
  claims [{ actual: "made", compare: "lacks-field", expected: { literal: "secret" } }]
end
