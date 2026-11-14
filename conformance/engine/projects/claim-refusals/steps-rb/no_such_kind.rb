class NoSuchKind < Nukadoko::Step
  description "A refused claim"
  pattern "the id is a thing"
  claims [{ actual: "id", compare: "is-a", expected: { literal: "thing" } }]

  def observe(args:) = {}
end
