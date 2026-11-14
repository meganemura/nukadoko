class CountIs < Nukadoko::Step
  description "The count is a number"
  pattern "the count is {expected:int}"
  args { number :expected, "The count" }
  claims [{ actual: "actual", compare: "equal", expected: "expected" }]

  def observe(args:) = { actual: 1 }
end
