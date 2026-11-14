class TagsShort < Nukadoko::Step
  description "A claim on the item"
  pattern "each tag of the item is a string"
  args { unknown :made, "The item" }
  from made: [MakeItem, :tags]
  claims [{ actual: "made", each: { claims: [{ compare: "is-a", expected: { literal: "string" } }] } }]
end
