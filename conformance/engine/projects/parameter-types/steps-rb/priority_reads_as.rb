class PriorityReadsAs < Nukadoko::Step
  description "A priority the line gives is this text"
  pattern "優先度{given:priority}は{expected:string}と読む"
  args do
    string :given, "The priority the line gives"
    string :expected, "The expected side"
  end
  claims [{ actual: "value", compare: "equal", expected: "expected" }]

  def observe(args:) = { value: args.given }
end
