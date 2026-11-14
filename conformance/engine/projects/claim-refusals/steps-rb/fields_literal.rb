class FieldsLiteral < Nukadoko::Step
  description "A refused claim"
  pattern "the item is red"
  claims [{ actual: "item", compare: "has-fields", expected: { literal: "red" } }]

  def observe(args:) = {}
end
