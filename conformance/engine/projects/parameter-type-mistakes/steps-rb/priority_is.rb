class PriorityIs < Nukadoko::Step
  description "The priority is the one the line gives"
  pattern "優先度は{expected:priority}である"
  args do
    string :expected, "The expected side"
  end
  claims [{ actual: "value", compare: "equal", expected: "expected" }]

  def observe(args:) = { value: "high" }
end
