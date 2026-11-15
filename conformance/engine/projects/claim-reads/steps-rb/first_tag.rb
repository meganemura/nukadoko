class FirstTag < Nukadoko::Step
  description "The first tag the value holds"
  pattern "the first-tag of {given:string} is {expected:string}"
  args do
    string :given, "The value observe reads, as JSON"
    string :expected, "The expected side"
  end
  claims [{ actual: "value", at: "tags.0", compare: "equal", expected: "expected" }]

  def observe(args:) = { value: JSON.parse(args.given) }
end
