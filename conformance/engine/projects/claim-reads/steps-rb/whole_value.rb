class WholeValue < Nukadoko::Step
  description "The value, as JSON"
  pattern "the whole-value of {given:string} is {expected:string}"
  args do
    string :given, "The value observe reads, as JSON"
    string :expected, "The expected side"
  end
  claims [{ actual: "value", compare: "equal", expected: "expected", expected_view: "json" }]

  def observe(args:) = { value: JSON.parse(args.given) }
end
