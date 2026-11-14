class WhereDecides < Nukadoko::Step
  description "A refused claim"
  pattern "each done item is done"
  claims [{ actual: "items", each: { where: [{ actual: "done", compare: "equal", expected: { literal: "done" } }], claims: [{ actual: "done", compare: "equal", expected: { literal: "done" } }] } }]

  def observe(args:) = {}
end
