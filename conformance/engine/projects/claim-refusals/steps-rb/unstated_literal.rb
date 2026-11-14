class UnstatedLiteral < Nukadoko::Step
  description "A refused claim"
  pattern "the colour is shown"
  claims [{ actual: "colour", compare: "equal", expected: { literal: "red" } }]

  def observe(args:) = {}
end
