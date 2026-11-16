class TheCountIs < Nukadoko::Step
  description "The count of open todos is a number"
  pattern "the count is {expected:int}"
  args do
    number :expected, "The expected count"
    field :count, OpenTodosCounted.returns[:count]
  end
  from count: [OpenTodosCounted, :count]
  claims [{ actual: "count", compare: "equal", expected: "expected" }]
end
