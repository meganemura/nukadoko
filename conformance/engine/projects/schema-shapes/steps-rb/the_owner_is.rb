class TheOwnerIs < Nukadoko::Step
  description "The owner the count names"
  pattern "the owner is {expected:string}"
  args do
    string :expected, "The expected owner"
    field :owner, OpenTodosCounted.returns[:owner]
  end
  from owner: [OpenTodosCounted, :owner]
  claims [{ actual: "owner", compare: "equal", expected: "expected" }]
end
