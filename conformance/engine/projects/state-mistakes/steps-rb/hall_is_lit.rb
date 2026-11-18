class HallIsLit < Nukadoko::Step
  description "The hall shows light"
  pattern "the hall shows light"
  args { string :light, "What the hall shows", optional: true }
  gives "lit"
  claims [{ actual: "light", compare: "equal", expected: { literal: "on" } }]

  def observe = { light: "on" }
end
